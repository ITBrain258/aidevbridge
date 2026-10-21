//! Blinded RSA file authentication using russh's external-signer interface.
//!
//! Key preparation happens before connecting. This adapter only signs russh's
//! session-bound authentication bytes; it is not a general signing endpoint.

use super::auth::AuthError;
use rsa::pkcs1v15::SigningKey;
use rsa::rand_core::TryCryptoRng;
use rsa::sha2::{Sha256, Sha512};
use rsa::signature::{RandomizedSigner, SignatureEncoding};
use russh::keys::agent::AgentIdentity;
use russh::keys::ssh_encoding::Encode;
use russh::keys::ssh_key::{self, private::RsaKeypair};
use russh::keys::{HashAlg, PublicKey};
use std::future::{ready, Future};

/// Owns the single prepared RSA key until the server's hash choice is known.
/// Deliberately neither Clone nor Debug: the private key must not be duplicated
/// for hash selection or exposed through formatting.
pub(crate) struct PreparedRsa {
    public: PublicKey,
    private: rsa::RsaPrivateKey,
    #[cfg(test)]
    lifetime: Option<std::sync::Arc<()>>,
}

impl PreparedRsa {
    pub(crate) fn new(key: &RsaKeypair, public: PublicKey) -> Result<Self, AuthError> {
        let invalid_key = || AuthError::KeyUnreadable("invalid RSA key components".into());
        let mut private = rsa::RsaPrivateKey::try_from(key).map_err(|_| invalid_key())?;
        // from_components attempts this already, but ignores its error. This is
        // a no-op after success and makes any preparation failure explicit here.
        private.precompute().map_err(|_| invalid_key())?;
        Ok(Self {
            public,
            private,
            #[cfg(test)]
            lifetime: None,
        })
    }

    pub(crate) fn into_signer(
        self,
        hash: Option<HashAlg>,
    ) -> Result<LocalRsaSigner, LocalRsaSignError> {
        let key = match hash {
            Some(HashAlg::Sha256) => RsaSigningKey::Sha256(SigningKey::new(self.private)),
            Some(HashAlg::Sha512) => RsaSigningKey::Sha512(SigningKey::new(self.private)),
            None => RsaSigningKey::Sha1(SigningKey::new(self.private)),
            Some(_) => return Err(LocalRsaSignError::Identity),
        };
        Ok(LocalRsaSigner {
            public: self.public,
            hash,
            key,
            #[cfg(test)]
            _lifetime: self.lifetime,
        })
    }

    #[cfg(test)]
    pub(crate) fn observe_lifetime(&mut self) -> std::sync::Weak<()> {
        let token = self.lifetime.get_or_insert_with(|| std::sync::Arc::new(()));
        std::sync::Arc::downgrade(token)
    }
}

enum RsaSigningKey {
    Sha256(SigningKey<Sha256>),
    Sha512(SigningKey<Sha512>),
    Sha1(SigningKey<sha1::Sha1>),
}

pub(crate) struct LocalRsaSigner {
    public: PublicKey,
    hash: Option<HashAlg>,
    key: RsaSigningKey,
    #[cfg(test)]
    _lifetime: Option<std::sync::Arc<()>>,
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum LocalRsaSignError {
    #[error("SSH authentication channel closed")]
    Send(#[from] russh::SendError),
    #[error("unexpected RSA signing identity or hash")]
    Identity,
    #[error("RSA signing failed")]
    Sign,
    #[error("SSH signature encoding failed")]
    Encoding,
}

impl From<LocalRsaSignError> for AuthError {
    fn from(error: LocalRsaSignError) -> Self {
        match error {
            LocalRsaSignError::Send(_) => Self::HostUnreachable,
            _ => Self::SigningFailed,
        }
    }
}

impl LocalRsaSigner {
    pub(crate) fn public_key(&self) -> &PublicKey {
        &self.public
    }

    /// The RNG parameter allows failure tests of the same path used in production.
    /// No failure may fall back to an unblinded signature or a different hash.
    fn sign_packet_with_rng<R: TryCryptoRng + ?Sized>(
        &self,
        identity: &AgentIdentity,
        hash: Option<HashAlg>,
        mut to_sign: Vec<u8>,
        rng: &mut R,
    ) -> Result<Vec<u8>, LocalRsaSignError> {
        match identity {
            AgentIdentity::PublicKey { key, .. }
                if key.key_data() == self.public.key_data() && hash == self.hash => {}
            _ => return Err(LocalRsaSignError::Identity),
        }

        let raw = match &self.key {
            RsaSigningKey::Sha256(key) => key.try_sign_with_rng(rng, &to_sign),
            RsaSigningKey::Sha512(key) => key.try_sign_with_rng(rng, &to_sign),
            RsaSigningKey::Sha1(key) => key.try_sign_with_rng(rng, &to_sign),
        }
        .map_err(|_| LocalRsaSignError::Sign)?;
        let signature =
            ssh_key::Signature::new(ssh_key::Algorithm::Rsa { hash: self.hash }, raw.to_vec())
                .map_err(|_| LocalRsaSignError::Encoding)?;
        let mut encoded = Vec::new();
        signature
            .encode(&mut encoded)
            .map_err(|_| LocalRsaSignError::Encoding)?;
        // russh expects original bytes + an SSH string containing the encoded
        // signature. Signature::encode alone would omit that outer string.
        encoded
            .encode(&mut to_sign)
            .map_err(|_| LocalRsaSignError::Encoding)?;
        Ok(to_sign)
    }
}

impl russh::Signer for LocalRsaSigner {
    type Error = LocalRsaSignError;

    fn auth_sign(
        &mut self,
        identity: &AgentIdentity,
        hash: Option<HashAlg>,
        to_sign: Vec<u8>,
    ) -> impl Future<Output = Result<Vec<u8>, Self::Error>> + Send {
        ready(self.sign_packet_with_rng(identity, hash, to_sign, &mut rand::rngs::SysRng))
    }
}

#[cfg(test)]
mod tests;
