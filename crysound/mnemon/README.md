# Bundled Mnemon CLI

`releases.json` pins the shared CLI version and SHA-512 digests of the npm `@mnemon-dev/mnemon` native platform archives. The web image and desktop package preparation run `prepare.mjs` to verify and extract the executable, package metadata, README and Apache-2.0 license. The native executable needs no Node/npm launcher. Desktop resources contain it outside ASAR at `crysound/mnemon/bin`; the company Host environment prepends this directory to PATH.

To upgrade, choose one Mnemon release, update `version` and every platform digest from `https://registry.npmjs.org/@mnemon-dev/mnemon/<version>-<platform>-<arch>`, then rebuild both the web image and desktop installers. Do not update executables in place. Keep enabled plugins and Provider settings unchanged.

```sh
node crysound/mnemon/prepare.mjs /tmp/mnemon-build
node crysound/mnemon/smoke.mjs /tmp/mnemon-build/bin
node --test crysound/mnemon/prepare.test.mjs
```

Preparation also accepts explicit target arguments, for example `darwin arm64` or `win32 x64`. Only run the smoke on its matching OS/architecture. The image build and native desktop `afterPack` hook run the smoke against the copied payload: it launches `mnemon` through PATH with no Node/npm on that PATH, checks the version, writes a fact in an isolated temporary store and recalls it in a separate process. It never opens personal memory stores. Run preparation a second time to check repeatability when upgrading.

This CLI smoke does not validate dsh-mnemon's UI or agent integration. After deployment, install dsh-mnemon in a test account, confirm Mnemon Native is available on the memory status page, store a fact in a Memory Space, and recall it from a new conversation. Attach status and recall screenshots to the PR; repeat on the next Mac and Windows installers. No third-party remote Provider needs to be enabled.
