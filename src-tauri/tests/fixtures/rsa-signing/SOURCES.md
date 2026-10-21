# Public RSA signing fixtures

These are intentionally public upstream test keys. They are not credentials and must never be used for a real SSH account or host. No personal key files were accessed and no keys were generated or converted for this fixture set.

Copied byte-for-byte on 2026-09-11 from the local crates.io source cache. Standalone upstream files are unchanged, including line endings and comments; only destination filenames differ. The additional russh PEM files contain verbatim string-literal payloads extracted from its public tests, without Rust declaration syntax or any key conversion. Source package versions and repository commits below come from the cached Cargo.toml and .cargo_vcs_info.json; Cargo.lock records the crates.io package checksums.

## Sources and formats

| Local file | Format | Passphrase | Exact upstream source |
|---|---|---|---|
| [rsa3072-openssh.key](rsa3072-openssh.key) | OpenSSH private key; 3072 bits | none | [ssh-key-0.7.0-rc.11: tests/examples/id_rsa_3072](https://github.com/RustCrypto/SSH/blob/7a1c757d2e2fcde32680e373d5226481de6d434e/ssh-key/tests/examples/id_rsa_3072) |
| [rsa3072.pub](rsa3072.pub) | OpenSSH public key; 3072 bits | n/a | [ssh-key-0.7.0-rc.11: tests/examples/id_rsa_3072.pub](https://github.com/RustCrypto/SSH/blob/7a1c757d2e2fcde32680e373d5226481de6d434e/ssh-key/tests/examples/id_rsa_3072.pub) |
| [rsa3072-putty-v3.ppk](rsa3072-putty-v3.ppk) | PuTTY PPK v3; 3072 bits | none | [ssh-key-0.7.0-rc.11: tests/examples/id_rsa_3072.ppk](https://github.com/RustCrypto/SSH/blob/7a1c757d2e2fcde32680e373d5226481de6d434e/ssh-key/tests/examples/id_rsa_3072.ppk) |
| [rsa3072-putty-v3-encrypted.ppk](rsa3072-putty-v3-encrypted.ppk) | PuTTY PPK v3; AES-256-CBC; 3072 bits | `123` | [ssh-key-0.7.0-rc.11: tests/examples/id_rsa_3072_enc.ppk](https://github.com/RustCrypto/SSH/blob/7a1c757d2e2fcde32680e373d5226481de6d434e/ssh-key/tests/examples/id_rsa_3072_enc.ppk) |
| [rsa3072-putty-v2.ppk](rsa3072-putty-v2.ppk) | PuTTY PPK v2; 3072 bits | none | [ssh-key-0.7.0-rc.11: tests/examples/id_rsa_3072.ppk2](https://github.com/RustCrypto/SSH/blob/7a1c757d2e2fcde32680e373d5226481de6d434e/ssh-key/tests/examples/id_rsa_3072.ppk2) |
| [rsa3072-putty-v2-encrypted.ppk](rsa3072-putty-v2-encrypted.ppk) | PuTTY PPK v2; AES-256-CBC; 3072 bits | `123` | [ssh-key-0.7.0-rc.11: tests/examples/id_rsa_3072_enc.ppk2](https://github.com/RustCrypto/SSH/blob/7a1c757d2e2fcde32680e373d5226481de6d434e/ssh-key/tests/examples/id_rsa_3072_enc.ppk2) |
| [rsa2048-pkcs1.pem](rsa2048-pkcs1.pem) | PKCS#1 RSA private key; PEM; 2048 bits | none | [rsa-0.10.0-rc.18: tests/examples/pkcs1/rsa2048-priv.pem](https://github.com/RustCrypto/RSA/blob/e31a0209de98cce82de44a5efc241912eb38f6ea/tests/examples/pkcs1/rsa2048-priv.pem) |
| [rsa2048-pkcs8.pem](rsa2048-pkcs8.pem) | PKCS#8 private key; PEM; 2048 bits | none | [rsa-0.10.0-rc.18: tests/examples/pkcs8/rsa2048-priv.pem](https://github.com/RustCrypto/RSA/blob/e31a0209de98cce82de44a5efc241912eb38f6ea/tests/examples/pkcs8/rsa2048-priv.pem) |
| [rsa2048-spki.pem](rsa2048-spki.pem) | SubjectPublicKeyInfo public key; PEM; 2048 bits | n/a | [rsa-0.10.0-rc.18: tests/examples/pkcs8/rsa2048-pub.pem](https://github.com/RustCrypto/RSA/blob/e31a0209de98cce82de44a5efc241912eb38f6ea/tests/examples/pkcs8/rsa2048-pub.pem) |
| [LICENSE-SSH-MIT](LICENSE-SSH-MIT) | MIT license notice | n/a | [ssh-key-0.7.0-rc.11: LICENSE-MIT](https://github.com/RustCrypto/SSH/blob/7a1c757d2e2fcde32680e373d5226481de6d434e/ssh-key/LICENSE-MIT) |
| [LICENSE-RSA-MIT](LICENSE-RSA-MIT) | MIT license notice | n/a | [rsa-0.10.0-rc.18: LICENSE-MIT](https://github.com/RustCrypto/RSA/blob/e31a0209de98cce82de44a5efc241912eb38f6ea/LICENSE-MIT) |

[rsa4096-cert.pub](rsa4096-cert.pub) is the byte-for-byte [public OpenSSH RSA-4096 certificate fixture](https://github.com/RustCrypto/SSH/blob/7a1c757d2e2fcde32680e373d5226481de6d434e/ssh-key/tests/examples/id_rsa_4096-cert.pub) from the same ssh-key package. It supports certificate-identity guard tests and needs no passphrase. It is covered by LICENSE-SSH-MIT.

The RustCrypto SSH package is ssh-key 0.7.0-rc.11, commit `7a1c757d2e2fcde32680e373d5226481de6d434e`. Its [RSA format tests](https://github.com/RustCrypto/SSH/blob/7a1c757d2e2fcde32680e373d5226481de6d434e/ssh-key/tests/private_key.rs) pass the OpenSSH, PPK v2 and PPK v3 variants through the same `validate_rsa_3072` assertions. The encrypted PPK calls explicitly supply `"123"`. These fixtures therefore provide the same public test key both unencrypted and passphrase-protected; the encrypted variants use PPK, not OpenSSH.

The RustCrypto RSA package is rsa 0.10.0-rc.18, commit `e31a0209de98cce82de44a5efc241912eb38f6ea`. Its [PKCS#1 tests](https://github.com/RustCrypto/RSA/blob/e31a0209de98cce82de44a5efc241912eb38f6ea/tests/pkcs1.rs) and [PKCS#8 tests](https://github.com/RustCrypto/RSA/blob/e31a0209de98cce82de44a5efc241912eb38f6ea/tests/pkcs8.rs) document the 2048-bit vectors and matching RSA parameters. The PKCS#1 comments trace that vector to the corresponding public pkcs8 crate example.

The inspected russh 0.63.2 decoder accepts OpenSSH, PKCS#1 PEM, PKCS#8 PEM and PPK. These files support parser/signing regressions; their presence does not expand this application's documented authentication-format support. No Cargo test, SSH, VM, GUI, key-generation or signing command was run while copying them.

## Additional encrypted PKCS#8 vector from russh

- [russh-rsa-pkcs1.pem](russh-rsa-pkcs1.pem): verbatim `PKCS8_RSA` literal from [russh/src/keys/mod.rs](https://github.com/warp-tech/russh/blob/8a51a0dca4f6fbdcc3ce98c627254026b25b3252/russh/src/keys/mod.rs). Despite the upstream constant name, its PEM label is `RSA PRIVATE KEY` (PKCS#1); it is unencrypted.
- [russh-rsa-pkcs8-encrypted.pem](russh-rsa-pkcs8-encrypted.pem): verbatim `PKCS8_ENCRYPTED` literal from the same file; `ENCRYPTED PRIVATE KEY` PEM. The upstream `test_pkcs8_encrypted` test explicitly uses passphrase `blabla`.

Source: cached russh 0.63.2, repository commit `8a51a0dca4f6fbdcc3ce98c627254026b25b3252` from .cargo_vcs_info.json; Apache-2.0 per Cargo.toml. The upstream tests decode these constants separately. This copy operation does not establish that they encode the same key or measure their key sizes; the known same-key encrypted pair remains the 3072-bit PPK set above.

## License and attribution

The RustCrypto ssh-key and rsa source packages offer MIT OR Apache-2.0. Those copies are included under the MIT option. Keep the accompanying original notices when redistributing:

- [LICENSE-SSH-MIT](LICENSE-SSH-MIT): Copyright (c) 2021-2026 The RustCrypto Project Developers.
- [LICENSE-RSA-MIT](LICENSE-RSA-MIT): the complete MIT notice supplied by RustCrypto/RSA (that file has no separate copyright header).

The two russh string-literal fixtures remain Apache-2.0. [LICENSE-APACHE-2.0](LICENSE-APACHE-2.0) contains the full Apache 2.0 text, copied from the cached rsa package's standard LICENSE-APACHE file because russh's packaged crate contains no separate license-text file. [NOTICE-RUSSH](NOTICE-RUSSH) preserves the copyright/license attribution from russh/src/lib.rs: Copyright 2016 Pierre-Étienne Meunier. The packaged russh crate contains no separate NOTICE file.

No fixture key bytes were modified. This provenance document, NOTICE-RUSSH wrapper and renamed destination paths are local additions.

## SHA-256 integrity inventory

Standalone fixture copies were compared with their cache files byte-for-byte. Extracted literals were compared with their exact source payloads. These hashes identify the fixture and notice bytes; they do not constitute a decoding or signing test.

```text
aadf5a1ef9531b6e76599fb1b0c11bc9a55250e77743627eae1cbffc45dec558  rsa3072-openssh.key
305915ffd3bd3db4e20dde3846dc0cf370f63e4c6d97835f17e33855f86d0d70  rsa3072.pub
0eeeb98eb3f61c65a247140e45f319639fc43e9cc0043ce845e84da7798ff3a8  rsa3072-putty-v3.ppk
4d31eaaeff934d75bec17aea565b8d78b24da692c50e32c493d596c01e0fef2c  rsa3072-putty-v3-encrypted.ppk
ceb5344e20b8e56eca4833ffef0f93a7ef11c4a731f082df792be233c5926ab4  rsa3072-putty-v2.ppk
a3f166ed4d694afd6a3bdd714d937a7c0f234d58519dba4570df750fa009f2b1  rsa3072-putty-v2-encrypted.ppk
026c0bc90e1d06dc828a90dc4fcfb29d5b4cd0eeb93123047035804092569086  rsa2048-pkcs1.pem
4df5e3254935a4f7d71e3b693d1b874091717f8b6075cd33f80ce4338d2ab0f2  rsa2048-pkcs8.pem
078c3983093e86784590a2a454547acad1d50992419334be697e442e954f02f8  rsa2048-spki.pem
57a4d75c1d095bb94754a478f3cd15e60ac66a5c5627d844be01a918eea5fe88  LICENSE-SSH-MIT
30fefc3a7d6a0041541858293bcbea2dde4caa4c0a5802f996a7f7e8c0085652  LICENSE-RSA-MIT
```

Additional extracted-fixture and license hashes:

```text
e85afb20c84b5925e0a3a8f1c73227b826e3973889b0cc43b5b86be19152e2c6  russh-rsa-pkcs1.pem
f0e8f607950b51d4ea420ce1dbb1d4827ceeb489bc68625f0b42cbe29507e85d  russh-rsa-pkcs8-encrypted.pem
769f80b5bcb42ed0af4e4d2fd74e1ac9bf843cb80c5a29219d1ef3544428a6bb  LICENSE-APACHE-2.0
190a6875ae3da6099c774da73bc593a35e4443967e527137d1e571c7f5aca90d  NOTICE-RUSSH
```

Certificate fixture SHA-256:

```text
a87b5c44147da873f15e6631eec1d15f779bc086f00edf1e28b72450a53ef7c7  rsa4096-cert.pub
```
