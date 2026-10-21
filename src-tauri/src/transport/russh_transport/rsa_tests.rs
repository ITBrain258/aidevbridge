use super::*;
use russh::keys::{ssh_key, PrivateKey, PublicKey};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/rsa-signing")
        .join(name)
}

struct TemporaryKey(PathBuf);

impl TemporaryKey {
    fn from_source(source: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "aidevbridge-rsa-connect-{}.key",
            rand::random::<u64>()
        ));
        std::fs::write(&path, source).unwrap();
        Self(path)
    }
}

impl Drop for TemporaryKey {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

struct Policy {
    accept: bool,
    calls: Arc<AtomicUsize>,
}

#[async_trait]
impl HostKeyPolicy for Policy {
    async fn decide(&self, host: &str, port: u16, _kind: &str, _key: &str) -> bool {
        assert_eq!(
            host,
            spec().hostname,
            "policy receives the original host, not the resolved IP"
        );
        assert_eq!(port, spec().port);
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.accept
    }
}

fn spec() -> HostSpec {
    HostSpec {
        hostname: "unused-memory-transport.invalid".into(),
        port: 22,
        user: "fixture-user".into(),
    }
}

#[tokio::test]
async fn rsa_signing_local_key_errors_happen_before_connector_or_host_policy() {
    let invalid = TemporaryKey::from_source("not a private key");
    let cases = [
        AuthMethod::Key {
            path: fixture("deliberately-absent.key"),
            passphrase: None,
        },
        AuthMethod::Key {
            path: invalid.0.clone(),
            passphrase: None,
        },
        AuthMethod::Key {
            path: fixture("rsa3072-putty-v2-encrypted.ppk"),
            passphrase: None,
        },
        AuthMethod::Key {
            path: fixture("russh-rsa-pkcs8-encrypted.pem"),
            passphrase: None,
        },
    ];
    for method in cases {
        let connector_calls = Arc::new(AtomicUsize::new(0));
        let host_calls = Arc::new(AtomicUsize::new(0));
        let calls = connector_calls.clone();
        let result = RusshTransport::connect_using(
            &spec(),
            Arc::new(Policy {
                accept: true,
                calls: host_calls.clone(),
            }),
            &method,
            move || {
                calls.fetch_add(1, Ordering::SeqCst);
                std::future::ready(Err(std::io::Error::other("connector must not run")))
            },
        )
        .await;
        let error = match result {
            Err(e) => e,
            Ok(_) => panic!("invalid fixture accepted"),
        };
        assert!(matches!(
            error.downcast_ref::<AuthError>(),
            Some(AuthError::KeyUnreadable(_) | AuthError::PassphraseRequired)
        ));
        assert_eq!(
            connector_calls.load(Ordering::SeqCst),
            0,
            "local preparation precedes TCP"
        );
        assert_eq!(host_calls.load(Ordering::SeqCst), 0);
    }
}

struct Server {
    expected: PublicKey,
    offered: Arc<AtomicUsize>,
    verified: Arc<AtomicUsize>,
}

impl russh::server::Handler for Server {
    type Error = russh::Error;
    async fn auth_publickey_offered(
        &mut self,
        _: &str,
        _: &PublicKey,
    ) -> Result<russh::server::Auth, Self::Error> {
        self.offered.fetch_add(1, Ordering::SeqCst);
        Ok(russh::server::Auth::Accept)
    }
    async fn auth_publickey(
        &mut self,
        user: &str,
        key: &PublicKey,
    ) -> Result<russh::server::Auth, Self::Error> {
        if user == "fixture-user" && key.key_data() == self.expected.key_data() {
            self.verified.fetch_add(1, Ordering::SeqCst);
            Ok(russh::server::Auth::Accept)
        } else {
            Ok(russh::server::Auth::reject())
        }
    }
}

#[tokio::test]
async fn rsa_signing_product_connect_prepares_once_and_preserves_real_host_policy() {
    for accept in [false, true] {
        let source = std::fs::read_to_string(fixture("rsa3072-openssh.key")).unwrap();
        let expected = PrivateKey::from_openssh(&source)
            .unwrap()
            .public_key()
            .clone();
        let temp = TemporaryKey::from_source(&source);
        let method = AuthMethod::Key {
            path: temp.0.clone(),
            passphrase: None,
        };
        let offered = Arc::new(AtomicUsize::new(0));
        let verified = Arc::new(AtomicUsize::new(0));
        let host_calls = Arc::new(AtomicUsize::new(0));
        let server_config = Arc::new(russh::server::Config {
            keys: vec![russh::keys::load_secret_key(fixture("rsa2048-pkcs1.pem"), None).unwrap()],
            preferred: russh::Preferred {
                key: std::borrow::Cow::Owned(vec![ssh_key::Algorithm::Rsa {
                    hash: Some(russh::keys::HashAlg::Sha256),
                }]),
                ..Default::default()
            },
            auth_rejection_time: Duration::ZERO,
            inactivity_timeout: None,
            ..Default::default()
        });
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let handler = Server {
            expected,
            offered: offered.clone(),
            verified: verified.clone(),
        };
        let mut server = tokio::spawn(async move {
            let (server_io, _) = listener.accept().await?;
            russh::server::run_stream(server_config, server_io, handler)
                .await?
                .await
        });
        let connector_calls = AtomicUsize::new(0);
        let result = tokio::time::timeout(
            Duration::from_secs(10),
            RusshTransport::connect_using(
                &spec(),
                Arc::new(Policy {
                    accept,
                    calls: host_calls.clone(),
                }),
                &method,
                || {
                    connector_calls.fetch_add(1, Ordering::SeqCst);
                    // Actual production authentication must use the already prepared
                    // key after this point; a late or second file read will fail.
                    std::fs::remove_file(&temp.0).unwrap();
                    TcpStream::connect(address)
                },
            ),
        )
        .await
        .unwrap();
        assert_eq!(connector_calls.load(Ordering::SeqCst), 1);
        assert_eq!(host_calls.load(Ordering::SeqCst), 1);
        if accept {
            assert!(
                result.is_ok(),
                "accepted host must authenticate from prepared key"
            );
            assert_eq!(offered.load(Ordering::SeqCst), 1);
            assert_eq!(
                verified.load(Ordering::SeqCst),
                1,
                "server verified real signature"
            );
            tokio::time::timeout(Duration::from_secs(1), result.as_ref().unwrap().dispose())
                .await
                .expect("dispose must not wait for a russh queue");
        } else {
            assert!(result.is_err());
            assert_eq!(
                offered.load(Ordering::SeqCst),
                0,
                "rejected host must not get an auth offer"
            );
            assert_eq!(verified.load(Ordering::SeqCst), 0);
        }
        let ended = tokio::time::timeout(Duration::from_secs(3), &mut server).await;
        if ended.is_err() {
            server.abort();
            let _ = server.await;
            panic!("TCP session remained open after rejection/dispose");
        }
        ended.unwrap().expect("server task panic").ok();
        // Successful dispose must release the peer even while the transport is
        // still alive, rather than relying on this later owner Drop.
        drop(result);
    }
}
