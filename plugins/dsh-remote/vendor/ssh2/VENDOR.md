# Vendored ssh2

- Upstream: https://github.com/mscdex/ssh2
- Version: v1.17.0 (`ssh2@1.17.0` on npm).
- License: MIT. The upstream copyright notice and license are preserved in `LICENSE`.
- Source: a fresh temporary project installed with `pnpm add ssh2@1.17.0 --ignore-scripts`; no build scripts were executed. This is not a copy of DSH's installed package.

## Changes

This copy keeps the upstream `lib/`, `LICENSE`, and `README.md`. Runtime JavaScript and the bundled Poly1305 WebAssembly implementation are unchanged. The package's name, version, main entry, and runtime dependencies (`asn1` and `bcrypt-pbkdf`) are unchanged.

The following are omitted:

- `scripts`, `optionalDependencies`, and `devDependencies` in `package.json`.
- `install.js`, all `binding.gyp` files, and `lib/protocol/crypto/src/`.
- Native build outputs, including `sshcrypto.node`, and optional native dependencies `cpu-features` and `nan`.
- Upstream tests, examples, development configuration, and supplementary documentation outside the retained files.

There are no install or postinstall hooks. `ssh2` automatically falls back when its optional native binding is absent. Encryption uses Node's built-in OpenSSL; the upstream JavaScript/WebAssembly implementation handles Poly1305. SSH and SFTP functionality remains available, with potentially lower throughput for bulk transfers than the native acceleration path.

## Upgrading

1. In a new temporary directory, fetch the intended upstream version using `npm pack ssh2@<version>` and extract it, or run `pnpm add ssh2@<version> --ignore-scripts`.
2. Replace this vendor directory with the new package's `lib/`, `LICENSE`, `README.md`, and `package.json`. Do not reuse an installed or compiled DSH copy.
3. Repeat the omissions above. Preserve the new upstream runtime dependencies and all runtime JavaScript/WebAssembly files; do not include native binaries.
4. Update this document and the plugin version. Review upstream changes and licenses, including changes to the native fallback and runtime dependencies.
5. Install the plugin in a clean directory with default pnpm build policy. Confirm the full dependency graph has no install/postinstall hooks or implicit `binding.gyp` builds, and `cpu-features` is absent.
6. Verify `ssh2.Client`, the disabled native binding, cipher availability, and the plugin's SSH/SFTP tests. For v1.17.0, `bindingAvailable` must be `false` and `Object.keys(CIPHER_INFO).length` must be `23`.
7. Reinstall in a real DSH profile without build approvals for `ssh2` or `cpu-features`, and check the plugin is active.
