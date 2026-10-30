use super::*;
use crate::ssh::auth::{
    authenticate_prepared, prepare_auth, prepare_auth_pair_owned, AuthMethod, PreparedAuth,
    PreparedKey,
};
use rand::{Rng, SeedableRng};
use rsa::rand_core::TryRng;
use rsa::signature::Verifier;
use rsa::traits::PrivateKeyParts;
use russh::keys::ssh_encoding::Decode;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/rsa-signing")
        .join(name)
}

fn method(name: &str, passphrase: Option<&str>) -> AuthMethod {
    AuthMethod::Key {
        path: fixture(name),
        passphrase: passphrase.map(|s| zeroize::Zeroizing::new(s.to_owned())),
    }
}

fn prepared(method: &AuthMethod) -> PreparedRsa {
    match prepare_auth(method).unwrap() {
        PreparedAuth::Key(PreparedKey::Rsa(key)) => *key,
        _ => panic!("fixture must prepare as RSA"),
    }
}

fn signer(hash: Option<HashAlg>) -> LocalRsaSigner {
    prepared(&method("rsa3072-openssh.key", None))
        .into_signer(hash)
        .unwrap()
}

struct TestRng {
    inner: rand::rngs::StdRng,
    calls: Arc<AtomicUsize>,
    fail_at: Option<usize>,
    zero_first: bool,
}

impl TestRng {
    fn new(seed: u64) -> Self {
        Self {
            inner: rand::rngs::StdRng::seed_from_u64(seed),
            calls: Arc::new(AtomicUsize::new(0)),
            fail_at: None,
            zero_first: false,
        }
    }
}

impl TryRng for TestRng {
    type Error = std::io::Error;

    fn try_next_u32(&mut self) -> Result<u32, Self::Error> {
        let mut bytes = [0; 4];
        self.try_fill_bytes(&mut bytes)?;
        Ok(u32::from_le_bytes(bytes))
    }

    fn try_next_u64(&mut self) -> Result<u64, Self::Error> {
        let mut bytes = [0; 8];
        self.try_fill_bytes(&mut bytes)?;
        Ok(u64::from_le_bytes(bytes))
    }

    fn try_fill_bytes(&mut self, bytes: &mut [u8]) -> Result<(), Self::Error> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        if self.fail_at == Some(call) {
            return Err(std::io::Error::other("injected RNG failure"));
        }
        if self.zero_first && call == 1 {
            // r=0 is not invertible; force another blinding RNG request.
            bytes.fill(0);
        } else {
            self.inner.fill_bytes(bytes);
        }
        Ok(())
    }
}

// Only public-fixture tests use this deterministic generator.
impl TryCryptoRng for TestRng {}

fn verify_packet(signer: &LocalRsaSigner, original: &[u8], packet: &[u8]) -> ssh_key::Signature {
    assert_eq!(&packet[..original.len()], original, "signed prefix changed");
    let mut tail = &packet[original.len()..];
    let blob = Vec::<u8>::decode(&mut tail).expect("outer SSH string");
    assert!(tail.is_empty(), "unexpected bytes after outer SSH string");
    let mut inner = blob.as_slice();
    let signature = ssh_key::Signature::decode(&mut inner).expect("inner SSH signature");
    assert!(inner.is_empty(), "unexpected bytes after signature");
    assert_eq!(
        signature.algorithm(),
        ssh_key::Algorithm::Rsa { hash: signer.hash }
    );
    Verifier::verify(&signer.public, original, &signature).unwrap();
    signature
}

#[test]
fn rsa_signing_all_hashes_use_rng_and_encode_valid_session_bound_signatures() {
    // Includes a binary session-id prefix, not just a friendly UTF-8 message.
    let original = b"\0\0\0\x04\xfe\x81\0\x01\x32\0\0\0\x04user ssh-connection publickey";
    for hash in [Some(HashAlg::Sha256), Some(HashAlg::Sha512), None] {
        let signer = signer(hash);
        let identity = signer.public.clone().into();
        let mut rng = TestRng::new(42);
        let packet = signer
            .sign_packet_with_rng(&identity, hash, original.to_vec(), &mut rng)
            .unwrap();
        assert!(
            rng.calls.load(Ordering::SeqCst) > 0,
            "private operation must use blinding RNG"
        );
        let signature = verify_packet(&signer, original, &packet);

        let mut changed_session = original.to_vec();
        changed_session[4] ^= 1;
        assert!(Verifier::verify(&signer.public, &changed_session, &signature).is_err());
        let mut changed_message = original.to_vec();
        *changed_message.last_mut().unwrap() ^= 1;
        assert!(Verifier::verify(&signer.public, &changed_message, &signature).is_err());
        let mut changed_bytes = signature.as_bytes().to_vec();
        changed_bytes[3] ^= 1;
        let corrupt = ssh_key::Signature::new(signature.algorithm(), changed_bytes).unwrap();
        assert!(Verifier::verify(&signer.public, original, &corrupt).is_err());

        let mut second_rng = TestRng::new(99);
        let second = signer
            .sign_packet_with_rng(&identity, hash, original.to_vec(), &mut second_rng)
            .unwrap();
        assert!(second_rng.calls.load(Ordering::SeqCst) > 0);
        assert_eq!(
            packet, second,
            "blinding must not change deterministic signature bytes"
        );
    }
}

#[test]
fn rsa_signing_rng_failure_never_falls_back_even_after_first_random_bytes() {
    for hash in [Some(HashAlg::Sha256), Some(HashAlg::Sha512), None] {
        let signer = signer(hash);
        let identity = signer.public.clone().into();
        for fail_at in [1, 2] {
            let mut rng = TestRng::new(5);
            rng.zero_first = fail_at == 2;
            rng.fail_at = Some(fail_at);
            assert!(matches!(
                signer.sign_packet_with_rng(&identity, hash, b"context".to_vec(), &mut rng),
                Err(LocalRsaSignError::Sign)
            ));
            assert_eq!(
                rng.calls.load(Ordering::SeqCst),
                fail_at,
                "no retry after RNG failure"
            );
        }
    }
}

#[test]
fn rsa_signing_identity_and_hash_guards_run_before_rng() {
    let signer = signer(Some(HashAlg::Sha256));
    let other_key = prepared(&method("rsa2048-pkcs1.pem", None)).public;
    let certificate = ssh_key::Certificate::from_openssh(
        &std::fs::read_to_string(fixture("rsa4096-cert.pub")).unwrap(),
    )
    .unwrap();
    let cases = [
        (other_key.into(), Some(HashAlg::Sha256)),
        (certificate.into(), Some(HashAlg::Sha256)),
        (signer.public.clone().into(), Some(HashAlg::Sha512)),
        (signer.public.clone().into(), None),
    ];
    let mut rng = TestRng::new(4);
    for (identity, hash) in cases {
        assert!(matches!(
            signer.sign_packet_with_rng(&identity, hash, b"context".to_vec(), &mut rng),
            Err(LocalRsaSignError::Identity)
        ));
    }
    assert_eq!(rng.calls.load(Ordering::SeqCst), 0);
}

#[test]
fn rsa_signing_preparation_moves_private_storage_and_drops_single_owner() {
    let mut prepared = prepared(&method("rsa3072-openssh.key", None));
    let lifetime = prepared.observe_lifetime();
    let storage = prepared.private.d().as_limbs().as_ptr();
    assert_eq!(lifetime.strong_count(), 1);
    let signer = prepared.into_signer(Some(HashAlg::Sha512)).unwrap();
    let RsaSigningKey::Sha512(ref key) = signer.key else {
        panic!("SHA-512 selected")
    };
    assert_eq!(
        storage,
        key.as_ref().d().as_limbs().as_ptr(),
        "key must move, not clone/reconvert"
    );
    assert_eq!(lifetime.strong_count(), 1);
    drop(signer);
    assert_eq!(lifetime.strong_count(), 0);
    let mut prepared = self::prepared(&method("rsa3072-openssh.key", None));
    let abandoned = prepared.observe_lifetime();
    drop(prepared);
    assert_eq!(
        abandoned.strong_count(),
        0,
        "unused preparation must be discarded"
    );
}

#[test]
fn rsa_signing_pair_prepares_same_identity_and_moves_each_key_for_independent_hashes() {
    let expected = PublicKey::from_openssh(include_str!(
        "../../../tests/fixtures/rsa-signing/rsa3072.pub"
    ))
    .unwrap();
    for (first_hash, second_hash) in [
        (Some(HashAlg::Sha256), Some(HashAlg::Sha512)),
        (None, Some(HashAlg::Sha256)),
    ] {
        let (
            PreparedAuth::Key(PreparedKey::Rsa(mut first)),
            PreparedAuth::Key(PreparedKey::Rsa(mut second)),
        ) = prepare_auth_pair_owned(method("rsa3072-openssh.key", None)).unwrap()
        else {
            panic!("RSA pair")
        };
        assert_eq!(first.public.key_data(), expected.key_data());
        assert_eq!(second.public.key_data(), expected.key_data());
        let first_lifetime = first.observe_lifetime();
        let second_lifetime = second.observe_lifetime();
        let first_storage = first.private.d().as_limbs().as_ptr();
        let second_storage = second.private.d().as_limbs().as_ptr();
        assert_ne!(
            first_storage, second_storage,
            "two preparations exist before hash selection"
        );
        let first = first.into_signer(first_hash).unwrap();
        let second = second.into_signer(second_hash).unwrap();
        for (signer, storage) in [(&first, first_storage), (&second, second_storage)] {
            let signing_storage = match &signer.key {
                RsaSigningKey::Sha256(key) => key.as_ref().d().as_limbs().as_ptr(),
                RsaSigningKey::Sha512(key) => key.as_ref().d().as_limbs().as_ptr(),
                RsaSigningKey::Sha1(key) => key.as_ref().d().as_limbs().as_ptr(),
            };
            assert_eq!(
                storage, signing_storage,
                "hash selection moves private storage"
            );
            let data = b"paired-session-bound-authentication";
            let mut rng = TestRng::new(42);
            let packet = signer
                .sign_packet_with_rng(
                    &signer.public.clone().into(),
                    signer.hash,
                    data.to_vec(),
                    &mut rng,
                )
                .unwrap();
            assert!(
                rng.calls.load(Ordering::SeqCst) > 0,
                "both paths retain blinding"
            );
            verify_packet(signer, data, &packet);
        }
        drop(first);
        assert_eq!(first_lifetime.strong_count(), 0);
        assert_eq!(second_lifetime.strong_count(), 1);
        drop(second);
        assert_eq!(second_lifetime.strong_count(), 0);
    }
}

#[test]
fn rsa_signing_pair_failure_and_abandoned_second_preparation_release_both_owners() {
    let (
        PreparedAuth::Key(PreparedKey::Rsa(mut first)),
        PreparedAuth::Key(PreparedKey::Rsa(mut second)),
    ) = prepare_auth_pair_owned(method("rsa3072-openssh.key", None)).unwrap()
    else {
        panic!("RSA pair")
    };
    let first_lifetime = first.observe_lifetime();
    let second_lifetime = second.observe_lifetime();
    let first = first.into_signer(Some(HashAlg::Sha256)).unwrap();
    let mut rng = TestRng::new(1);
    rng.fail_at = Some(1);
    assert!(matches!(
        first.sign_packet_with_rng(
            &first.public.clone().into(),
            first.hash,
            b"first-pair-authentication".to_vec(),
            &mut rng,
        ),
        Err(LocalRsaSignError::Sign)
    ));
    assert_eq!(rng.calls.load(Ordering::SeqCst), 1, "no unblinded fallback");
    drop(first);
    assert_eq!(first_lifetime.strong_count(), 0);
    assert_eq!(second_lifetime.strong_count(), 1);
    drop(second);
    assert_eq!(second_lifetime.strong_count(), 0);
}

#[test]
fn rsa_signing_prepared_key_no_longer_reads_file() {
    let path = std::env::temp_dir().join(format!(
        "aidevbridge-rsa-public-fixture-{}.key",
        rand::random::<u64>()
    ));
    std::fs::copy(fixture("rsa3072-openssh.key"), &path).unwrap();
    let method = AuthMethod::Key {
        path: path.clone(),
        passphrase: None,
    };
    let prepared = prepared(&method);
    std::fs::remove_file(&path).unwrap();
    let signer = prepared.into_signer(Some(HashAlg::Sha256)).unwrap();
    let identity = signer.public.clone().into();
    for index in 0..2 {
        let original = format!("connection-context-{index}").into_bytes();
        let packet = signer
            .sign_packet_with_rng(
                &identity,
                signer.hash,
                original.clone(),
                &mut TestRng::new(index),
            )
            .unwrap();
        verify_packet(&signer, &original, &packet);
    }
    assert!(
        matches!(prepare_auth(&method), Err(AuthError::KeyUnreadable(_))),
        "a new attempt reads the changed file"
    );
}

#[test]
fn rsa_signing_supported_formats_prepare_and_sign_with_existing_identity() {
    use rsa::pkcs8::DecodePublicKey;
    let public2048 = rsa::RsaPublicKey::from_public_key_pem(
        &std::fs::read_to_string(fixture("rsa2048-spki.pem")).unwrap(),
    )
    .unwrap();
    let public3072 =
        PublicKey::from_openssh(&std::fs::read_to_string(fixture("rsa3072.pub")).unwrap()).unwrap();
    let cases = [
        ("rsa3072-openssh.key", None, true),
        ("rsa3072-putty-v2.ppk", None, true),
        ("rsa3072-putty-v3.ppk", None, true),
        ("rsa3072-putty-v2-encrypted.ppk", Some("123"), true),
        ("rsa3072-putty-v3-encrypted.ppk", Some("123"), true),
        ("rsa2048-pkcs1.pem", None, false),
        ("rsa2048-pkcs8.pem", None, false),
        ("russh-rsa-pkcs1.pem", None, false),
        ("russh-rsa-pkcs8-encrypted.pem", Some("blabla"), false),
    ];
    for (name, passphrase, same_key) in cases {
        let signer = prepared(&method(name, passphrase))
            .into_signer(Some(HashAlg::Sha256))
            .unwrap();
        if same_key {
            assert_eq!(signer.public.key_data(), public3072.key_data(), "{name}");
        }
        if name.starts_with("rsa2048-") {
            let RsaSigningKey::Sha256(key) = &signer.key else {
                panic!("SHA-256")
            };
            assert_eq!(
                key.as_ref().to_public_key(),
                public2048,
                "independent public fixture: {name}"
            );
        }
        let data = b"format-regression";
        let packet = signer
            .sign_packet_with_rng(
                &signer.public.clone().into(),
                signer.hash,
                data.to_vec(),
                &mut TestRng::new(42),
            )
            .unwrap();
        verify_packet(&signer, data, &packet);
    }
}

#[test]
fn rsa_signing_encrypted_key_errors_preserve_format_specific_classification() {
    for name in [
        "rsa3072-putty-v2-encrypted.ppk",
        "rsa3072-putty-v3-encrypted.ppk",
        "russh-rsa-pkcs8-encrypted.pem",
    ] {
        for password in [None, Some("wrong")] {
            let actual = match prepare_auth(&method(name, password)) {
                Err(error) => error,
                Ok(_) => panic!("must reject {name}"),
            };
            if password.is_none() {
                assert!(
                    matches!(actual, AuthError::PassphraseRequired),
                    "{name}: {actual}"
                );
            } else {
                assert!(
                    matches!(actual, AuthError::PassphraseWrong),
                    "{name}: {actual}"
                );
            }
        }
    }
}

#[test]
fn rsa_signing_sysrng_hook_future_is_send_and_signs() {
    fn assert_send<T: Send>(value: T) -> T {
        value
    }
    let mut signer = signer(Some(HashAlg::Sha256));
    let identity = signer.public.clone().into();
    use russh::Signer;
    let future =
        assert_send(signer.auth_sign(&identity, Some(HashAlg::Sha256), b"context".to_vec()));
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let packet = runtime.block_on(future).unwrap();
    verify_packet(&signer, b"context", &packet);
}

// These sessions use in-process duplex streams: no socket, SSH program, VM,
// user credential or environment-provided test host is involved.
struct ClientHandler {
    expected_host: PublicKey,
}

impl russh::client::Handler for ClientHandler {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        Ok(
            matches!(key, russh::keys::PublicKeyOrCertificate::PublicKey { key, .. } if key.key_data() == self.expected_host.key_data()),
        )
    }
}

struct ServerHandler {
    expected_client: PublicKey,
    accepted: Arc<AtomicUsize>,
}

impl russh::server::Handler for ServerHandler {
    type Error = russh::Error;
    async fn auth_publickey(
        &mut self,
        user: &str,
        key: russh::server::VerifiedPublicKey<'_>,
    ) -> Result<russh::server::Auth, Self::Error> {
        if user == "fixture-user" && key.public_key.key_data() == self.expected_client.key_data() {
            self.accepted.fetch_add(1, Ordering::SeqCst);
            Ok(russh::server::Auth::Accept)
        } else {
            Ok(russh::server::Auth::reject())
        }
    }
}

async fn session(
    hash: Option<HashAlg>,
    expected_host: Option<PublicKey>,
) -> (
    Result<russh::client::Handle<ClientHandler>, russh::Error>,
    tokio::task::JoinHandle<Result<(), russh::Error>>,
    Arc<AtomicUsize>,
) {
    let host_key = russh::keys::load_secret_key(fixture("rsa2048-pkcs1.pem"), None).unwrap();
    let actual_host = host_key.public_key().clone();
    let expected_client = prepared(&method("rsa3072-openssh.key", None)).public;
    let accepted = Arc::new(AtomicUsize::new(0));
    let server_config = Arc::new(russh::server::Config {
        keys: vec![host_key],
        preferred: russh::Preferred {
            key: std::borrow::Cow::Owned(vec![ssh_key::Algorithm::Rsa { hash }]),
            ..Default::default()
        },
        auth_rejection_time: Duration::ZERO,
        auth_rejection_time_initial: Some(Duration::ZERO),
        inactivity_timeout: None, // EOF must come from cleanup, never this timeout.
        ..Default::default()
    });
    let (client_io, server_io) = tokio::io::duplex(128 * 1024);
    let handler = ServerHandler {
        expected_client,
        accepted: accepted.clone(),
    };
    let server = tokio::spawn(async move {
        russh::server::run_stream(server_config, server_io, handler)
            .await?
            .await
    });
    let client_config = Arc::new(russh::client::Config {
        preferred: russh::Preferred {
            key: std::borrow::Cow::Owned(vec![ssh_key::Algorithm::Rsa { hash }]),
            ..Default::default()
        },
        ..Default::default()
    });
    let result = tokio::time::timeout(
        Duration::from_secs(10),
        russh::client::connect_stream(
            client_config,
            client_io,
            ClientHandler {
                expected_host: expected_host.unwrap_or(actual_host),
            },
        ),
    )
    .await
    .expect("hermetic handshake deadline");
    (result, server, accepted)
}

async fn peer_ends(mut server: tokio::task::JoinHandle<Result<(), russh::Error>>) {
    let result = tokio::time::timeout(Duration::from_secs(3), &mut server).await;
    if result.is_err() {
        server.abort();
        panic!("peer did not see EOF after dropping authentication handle");
    }
    result.unwrap().expect("server task must not panic").ok();
}

#[tokio::test]
async fn rsa_signing_real_ssh_authentication_negotiates_each_existing_hash() {
    for hash in [Some(HashAlg::Sha256), Some(HashAlg::Sha512), None] {
        let auth_method = method("rsa3072-openssh.key", None);
        let mut prepared = prepare_auth(&auth_method).unwrap();
        let PreparedAuth::Key(PreparedKey::Rsa(ref mut key)) = prepared else {
            panic!("RSA")
        };
        let lifetime = key.observe_lifetime();
        let (client, server, accepted) = session(hash, None).await;
        let mut client = client.unwrap();
        assert_eq!(client.best_supported_rsa_hash().await.unwrap(), Some(hash));
        tokio::time::timeout(
            Duration::from_secs(10),
            authenticate_prepared(&mut client, "fixture-user", prepared),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(
            accepted.load(Ordering::SeqCst),
            1,
            "server verified actual signature"
        );
        assert_eq!(
            lifetime.strong_count(),
            0,
            "private signer released after authentication"
        );
        drop(client);
        peer_ends(server).await;
    }
}

#[tokio::test]
async fn rsa_signing_wrong_prepared_variant_cannot_use_unblinded_fallback() {
    let (client, server, accepted) = session(Some(HashAlg::Sha256), None).await;
    let mut client = client.unwrap();
    let rsa = russh::keys::load_secret_key(fixture("rsa3072-openssh.key"), None).unwrap();
    let wrong_variant = PreparedAuth::Key(PreparedKey::Other(Arc::new(rsa)));
    assert!(matches!(
        authenticate_prepared(&mut client, "fixture-user", wrong_variant).await,
        Err(AuthError::SigningFailed)
    ));
    assert_eq!(accepted.load(Ordering::SeqCst), 0);
    drop(client);
    peer_ends(server).await;
}

#[tokio::test]
async fn rsa_signing_dropping_unpolled_authentication_future_releases_prepared_owner() {
    let method = method("rsa3072-openssh.key", None);
    let mut prepared = prepare_auth(&method).unwrap();
    let PreparedAuth::Key(PreparedKey::Rsa(ref mut key)) = prepared else {
        panic!("RSA")
    };
    let lifetime = key.observe_lifetime();
    let (client, server, accepted) = session(Some(HashAlg::Sha256), None).await;
    let mut client = client.unwrap();
    let future = authenticate_prepared(&mut client, "fixture-user", prepared);
    assert_eq!(lifetime.strong_count(), 1);
    drop(future);
    assert_eq!(lifetime.strong_count(), 0);
    assert_eq!(accepted.load(Ordering::SeqCst), 0);
    drop(client);
    peer_ends(server).await;
}

struct ObservedSigner {
    inner: LocalRsaSigner,
    rng: TestRng,
    requests: Arc<AtomicUsize>,
}

impl russh::Signer for ObservedSigner {
    type Error = LocalRsaSignError;
    fn auth_sign(
        &mut self,
        key: &AgentIdentity,
        hash: Option<HashAlg>,
        data: Vec<u8>,
    ) -> impl Future<Output = Result<Vec<u8>, Self::Error>> + Send {
        self.requests.fetch_add(1, Ordering::SeqCst);
        ready(
            self.inner
                .sign_packet_with_rng(key, hash, data, &mut self.rng),
        )
    }
}

#[tokio::test]
async fn rsa_signing_real_ssh_rng_failure_drops_owner_and_peer_gets_eof() {
    let hash = Some(HashAlg::Sha256);
    let mut prepared = prepared(&method("rsa3072-openssh.key", None));
    let lifetime = prepared.observe_lifetime();
    let mut rng = TestRng::new(1);
    rng.fail_at = Some(1);
    let calls = rng.calls.clone();
    let requests = Arc::new(AtomicUsize::new(0));
    let mut signer = ObservedSigner {
        inner: prepared.into_signer(hash).unwrap(),
        rng,
        requests: requests.clone(),
    };
    let (client, server, accepted) = session(hash, None).await;
    let mut client = client.unwrap();
    let error = tokio::time::timeout(
        Duration::from_secs(10),
        client.authenticate_publickey_with(
            "fixture-user",
            signer.inner.public.clone(),
            hash,
            &mut signer,
        ),
    )
    .await
    .unwrap()
    .unwrap_err();
    assert!(matches!(AuthError::from(error), AuthError::SigningFailed));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    assert_eq!(accepted.load(Ordering::SeqCst), 0);
    drop(signer);
    drop(client); // Same fail-and-drop contract as RusshTransport::connect.
    assert_eq!(lifetime.strong_count(), 0);
    peer_ends(server).await;
}

#[tokio::test]
async fn rsa_signing_rejected_host_never_requests_auth_signature() {
    let hash = Some(HashAlg::Sha256);
    let mut prepared = prepared(&method("rsa3072-openssh.key", None));
    let lifetime = prepared.observe_lifetime();
    let mut signer = ObservedSigner {
        inner: prepared.into_signer(hash).unwrap(),
        rng: TestRng::new(1),
        requests: Arc::new(AtomicUsize::new(0)),
    };
    let wrong_host = signer.inner.public.clone();
    let (client, server, accepted) = session(hash, Some(wrong_host)).await;
    if let Ok(mut client) = client {
        // A wrongly accepted host must hit the same observed signer as the
        // positive control, not silently skip the assertion's subject.
        let _ = client
            .authenticate_publickey_with(
                "fixture-user",
                signer.inner.public.clone(),
                hash,
                &mut signer,
            )
            .await;
        panic!("wrong host accepted");
    }
    assert_eq!(signer.requests.load(Ordering::SeqCst), 0);
    assert_eq!(signer.rng.calls.load(Ordering::SeqCst), 0);
    assert_eq!(accepted.load(Ordering::SeqCst), 0);
    drop(signer);
    assert_eq!(lifetime.strong_count(), 0);
    peer_ends(server).await;

    let (client, server, accepted) = session(hash, None).await;
    let mut client = client.unwrap();
    let mut signer = ObservedSigner {
        inner: self::signer(hash),
        rng: TestRng::new(1),
        requests: Arc::new(AtomicUsize::new(0)),
    };
    assert!(client
        .authenticate_publickey_with(
            "fixture-user",
            signer.inner.public.clone(),
            hash,
            &mut signer
        )
        .await
        .unwrap()
        .success());
    assert_eq!(signer.requests.load(Ordering::SeqCst), 1);
    assert!(signer.rng.calls.load(Ordering::SeqCst) > 0);
    assert_eq!(accepted.load(Ordering::SeqCst), 1);
    drop(client);
    peer_ends(server).await;
}
