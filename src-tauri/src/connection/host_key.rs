use crate::ssh::known_hosts::{self, HostKeyDecision};
use crate::transport::{ConnectControl, HostKeyPolicy, HostSpec};
use async_trait::async_trait;
use base64::Engine;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// A single connection pair's public identity; never a credential cache.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct HostKeyPin {
    host: String,
    port: u16,
    algorithm: String,
    bytes: Vec<u8>,
}

impl HostKeyPin {
    fn from_wire(host: &str, port: u16, algorithm: &str, key: &str) -> Option<Self> {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(key)
            .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(key))
            .ok()?;
        Some(Self {
            host: host.into(),
            port,
            algorithm: algorithm.into(),
            bytes,
        })
    }

    fn matches(&self, host: &str, port: u16, algorithm: &str, key: &str) -> bool {
        Self::from_wire(host, port, algorithm, key).as_ref() == Some(self)
    }
}

/// The first leg delegates actual consent; the second must use the exact pin.
/// Taking the initial policy releases its AppState/file snapshot after consent,
/// rather than retaining that owner through the long-lived russh handlers.
pub(crate) struct PairHostKeyPolicy {
    host: String,
    port: u16,
    control: ConnectControl,
    initial: Mutex<Option<Arc<dyn HostKeyPolicy>>>,
    pin: Mutex<Option<HostKeyPin>>,
    rejected: AtomicBool,
}

impl PairHostKeyPolicy {
    pub(crate) fn new(
        spec: &HostSpec,
        control: ConnectControl,
        initial: Arc<dyn HostKeyPolicy>,
    ) -> Self {
        Self {
            host: spec.hostname.clone(),
            port: spec.port,
            control,
            initial: Mutex::new(Some(initial)),
            pin: Mutex::new(None),
            rejected: AtomicBool::new(false),
        }
    }

    pub(crate) fn pin(&self) -> Option<HostKeyPin> {
        self.pin.lock().unwrap().clone()
    }

    pub(crate) fn rejected(&self) -> bool {
        self.rejected.load(Ordering::Acquire)
    }

    fn reject(&self) -> bool {
        self.rejected.store(true, Ordering::Release);
        false
    }
}

#[async_trait]
impl HostKeyPolicy for PairHostKeyPolicy {
    /// Nach dem ersten Zweig der Typ des Pins, damit der zweite denselben
    /// Schluessel aushandelt; vorher die Typen der eigentlichen Policy.
    fn known_key_types(&self, host: &str, port: u16) -> Vec<String> {
        if host != self.host || port != self.port {
            return Vec::new();
        }
        if let Some(pin) = self.pin() {
            return vec![pin.algorithm];
        }
        self.initial
            .lock()
            .unwrap()
            .as_ref()
            .map(|initial| initial.known_key_types(host, port))
            .unwrap_or_default()
    }

    async fn decide(&self, host: &str, port: u16, algorithm: &str, key: &str) -> bool {
        if host != self.host || port != self.port {
            return self.reject();
        }
        let pin = self.pin();
        if let Some(pin) = pin {
            let matches = pin.matches(host, port, algorithm, key);
            let accept = || if matches { true } else { self.reject() };
            return self.control.with_active(accept).unwrap_or(false);
        }
        if self.control.with_active(|| ()).is_err() {
            return false;
        }
        let Some(pin) = HostKeyPin::from_wire(host, port, algorithm, key) else {
            return self.reject();
        };
        let initial = self.initial.lock().unwrap().take();
        let Some(initial) = initial else {
            return self.reject();
        };
        if !initial.decide(host, port, algorithm, key).await {
            return false;
        }
        self.control
            .with_active(|| {
                *self.pin.lock().unwrap() = Some(pin);
                true
            })
            .unwrap_or(false)
    }
}

/// Repair keeps terminal identity but always honors current known-host denials.
/// Unknown can use the existing pair's explicit pin, including failed earlier
/// persistence; a new key can never initiate another TOFU prompt here.
pub(crate) struct RepairHostKeyPolicy {
    pin: HostKeyPin,
    known_hosts: String,
    control: ConnectControl,
    rejected: AtomicBool,
}

impl RepairHostKeyPolicy {
    pub(crate) fn new(pin: HostKeyPin, known_hosts: String, control: ConnectControl) -> Self {
        Self {
            pin,
            known_hosts,
            control,
            rejected: AtomicBool::new(false),
        }
    }

    pub(crate) fn rejected(&self) -> bool {
        self.rejected.load(Ordering::Acquire)
    }
}

#[async_trait]
impl HostKeyPolicy for RepairHostKeyPolicy {
    /// Der Typ des Pins: Die Reparatur nimmt nur diesen einen Schluessel an.
    fn known_key_types(&self, host: &str, port: u16) -> Vec<String> {
        if host != self.pin.host || port != self.pin.port {
            return Vec::new();
        }
        vec![self.pin.algorithm.clone()]
    }

    async fn decide(&self, host: &str, port: u16, algorithm: &str, key: &str) -> bool {
        let allowed = known_hosts::lookup(&self.known_hosts, host, port, algorithm, key)
            != HostKeyDecision::Mismatch
            && self.pin.matches(host, port, algorithm, key);
        let accept = || {
            if !allowed {
                self.rejected.store(true, Ordering::Release);
            }
            allowed
        };
        self.control.with_active(accept).unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    struct Consent(Arc<AtomicUsize>);
    #[async_trait]
    impl HostKeyPolicy for Consent {
        async fn decide(&self, _: &str, _: u16, _: &str, _: &str) -> bool {
            self.0.fetch_add(1, Ordering::SeqCst);
            true
        }
    }

    fn spec() -> HostSpec {
        HostSpec {
            hostname: "fixture.invalid".into(),
            port: 2222,
            user: "fixture".into(),
        }
    }

    #[tokio::test]
    async fn pair_reuses_one_consent_by_decoded_identity_and_releases_initial_policy() {
        let calls = Arc::new(AtomicUsize::new(0));
        let initial = Arc::new(Consent(calls.clone()));
        let weak = Arc::downgrade(&initial);
        let policy = PairHostKeyPolicy::new(&spec(), ConnectControl::default(), initial);
        // These are binding-unit bytes, not a claim to parse an SSH public key.
        assert!(
            policy
                .decide("fixture.invalid", 2222, "ssh-ed25519", "AQIDBA==")
                .await
        );
        assert!(weak.upgrade().is_none());
        assert!(
            policy
                .decide("fixture.invalid", 2222, "ssh-ed25519", "AQIDBA")
                .await
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        for (host, port, algorithm, key) in [
            ("other.invalid", 2222, "ssh-ed25519", "AQIDBA=="),
            ("fixture.invalid", 22, "ssh-ed25519", "AQIDBA=="),
            ("fixture.invalid", 2222, "ssh-rsa", "AQIDBA=="),
            ("fixture.invalid", 2222, "ssh-ed25519", "AQIDBQ=="),
        ] {
            assert!(!policy.decide(host, port, algorithm, key).await);
        }
        assert!(policy.rejected());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn repair_checks_current_revocation_before_using_an_unpersisted_pin() {
        const KEY: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIAD1+Ea/eX8XGszB1Ee5udPD85hQSr6XBZCh4YIzFLng";
        let pin = HostKeyPin::from_wire("fixture.invalid", 2222, "ssh-ed25519", KEY).unwrap();
        let unknown =
            RepairHostKeyPolicy::new(pin.clone(), String::new(), ConnectControl::default());
        assert!(
            unknown
                .decide("fixture.invalid", 2222, "ssh-ed25519", KEY)
                .await
        );
        let revoked = RepairHostKeyPolicy::new(
            pin,
            format!("@revoked * ssh-ed25519 {KEY}\n"),
            ConnectControl::default(),
        );
        assert!(
            !revoked
                .decide("fixture.invalid", 2222, "ssh-ed25519", KEY)
                .await
        );
        assert!(revoked.rejected());
    }

    #[tokio::test]
    async fn cancelled_pair_cannot_reuse_prior_consent() {
        let calls = Arc::new(AtomicUsize::new(0));
        let control = ConnectControl::default();
        let policy =
            PairHostKeyPolicy::new(&spec(), control.clone(), Arc::new(Consent(calls.clone())));
        assert!(
            policy
                .decide("fixture.invalid", 2222, "ssh-ed25519", "AQIDBA==")
                .await
        );
        control.cancel();
        assert!(
            !policy
                .decide("fixture.invalid", 2222, "ssh-ed25519", "AQIDBA==")
                .await
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    /// Kennt den Host unter festen Typen und stimmt jedem Schluessel zu.
    struct KnownTypes(Vec<String>);
    #[async_trait]
    impl HostKeyPolicy for KnownTypes {
        async fn decide(&self, _: &str, _: u16, _: &str, _: &str) -> bool {
            true
        }
        fn known_key_types(&self, _: &str, _: u16) -> Vec<String> {
            self.0.clone()
        }
    }

    #[tokio::test]
    async fn pair_orders_by_the_initial_policy_and_then_by_its_pin() {
        let initial = Arc::new(KnownTypes(vec![
            "ecdsa-sha2-nistp256".into(),
            "ssh-rsa".into(),
        ]));
        let policy = PairHostKeyPolicy::new(&spec(), ConnectControl::default(), initial);
        assert_eq!(
            policy.known_key_types("fixture.invalid", 2222),
            ["ecdsa-sha2-nistp256", "ssh-rsa"]
        );
        assert!(policy.known_key_types("other.invalid", 2222).is_empty());
        assert!(
            policy
                .decide("fixture.invalid", 2222, "ecdsa-sha2-nistp256", "AQIDBA==")
                .await
        );
        // The second leg must negotiate the pinned key, nothing else.
        assert_eq!(
            policy.known_key_types("fixture.invalid", 2222),
            ["ecdsa-sha2-nistp256"]
        );
    }

    #[test]
    fn repair_orders_by_its_pin() {
        let pin = HostKeyPin::from_wire("fixture.invalid", 2222, "ssh-rsa", "AQIDBA==").unwrap();
        let policy = RepairHostKeyPolicy::new(pin, String::new(), ConnectControl::default());
        assert_eq!(policy.known_key_types("fixture.invalid", 2222), ["ssh-rsa"]);
        assert!(policy.known_key_types("fixture.invalid", 22).is_empty());
    }
}
