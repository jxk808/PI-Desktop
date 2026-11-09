# Custom Windows artifact build acceptance

The fork's `custom-windows.yml` is manually dispatched only for `custom/main` and
has read-only repository permissions. It produces verified build artifacts, not
GitHub Releases or an automatically installed client.

Required journey:

1. Provision pinned clean portable automation dependencies from authenticated
   official endpoints. Verify embedded Python and Node archive SHA-256, exact
   compatible PyPI wheels and the existing npm lockfile. Never copy accounts,
   browser profiles, a developer virtualenv or ambient machine runtimes.
2. Build/test the current Rust Host source on Windows with the current Cargo
   lockfile. Build workspace sources and check Desktop types. Preserve the
   custom quota plugin, account recovery and Chinese mention behavior.
3. Run the full custom installer build without the installed-host reuse option.
4. Extract NSIS's actual payload, verify all runtime integrity entries and quota
   plugin source/permission; compare Host, sidecar and archived compiled outputs
   against this run, then perform sidecar health and runtime relocation probes.
5. Upload installer, commit/compiler provenance and SHA-256 manifest only after
   verification. A failed job must not publish an apparently successful installer.

Coverage: `custom/prepare-runtime.test.mjs`, `custom/packaged-runtime.test.mjs`,
`custom/integration.test.mjs`, the runtime fallback suites and the actual CI
`custom/verify-windows-package.mjs`/portable-runtime integration steps. The build
artifact must identify its exact Git commit and freshly compiled Host hash.
Neither source push nor passing local script tests claims remote-build success.
Real account login and second-machine installation remain separate acceptance.
