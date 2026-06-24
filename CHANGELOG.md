# Changelog

## [0.11.2](https://github.com/sidpalas/deputies/compare/v0.11.1...v0.11.2) (2026-06-24)


### Continuous Integration

* upgrade mise from 2026.6.2 to 2026.6.13 and mise-action from v4.1.0 to v4.2.0 ([1c0dc17](https://github.com/sidpalas/deputies/commit/1c0dc1753539ef04702cf1ed7d5bd37e1b6522c0))


### Bug Fixes

* backfill fast new-session responses ([#76](https://github.com/sidpalas/deputies/issues/76)) ([628776f](https://github.com/sidpalas/deputies/commit/628776fd955379f1b9558760e4f245ba5b967512))
* cancel new-session backfill requests ([bc71e41](https://github.com/sidpalas/deputies/commit/bc71e41d700e997d9ba83148d1ba832cf1502e0f))
* configure mise monorepo roots ([#75](https://github.com/sidpalas/deputies/issues/75)) ([9161a0b](https://github.com/sidpalas/deputies/commit/9161a0b82d8bde774395b39e5e1c626f98af5caf))
* scope config validation by run mode ([8b84a24](https://github.com/sidpalas/deputies/commit/8b84a24bf37f2c01114820868872a49b27e57de1))
* use stable mise monorepo root ([9b8d641](https://github.com/sidpalas/deputies/commit/9b8d641c9ab2b5475fa88f044e687c241be6daa0))


### Tests

* stabilize full-stack smoke test ([7ae44d7](https://github.com/sidpalas/deputies/commit/7ae44d72fdbceb5531e715a6f69810f57de29e2e))

## [0.11.1](https://github.com/sidpalas/deputies/compare/v0.11.0...v0.11.1) (2026-06-16)


### Bug Fixes

* preserve test runs during releases ([dae52e7](https://github.com/sidpalas/deputies/commit/dae52e7829ac273213c08200fd2246935ddd6d35))
* use trixie node images ([4f86a99](https://github.com/sidpalas/deputies/commit/4f86a9981af108fad5feed0177a9566a14e3738e))


### Tests

* remove unused callback counter ([ef7e7c6](https://github.com/sidpalas/deputies/commit/ef7e7c6c567f29f0bb41d44ac4f57cf949a8bc95))
* wait for callback delivery persistence ([6777695](https://github.com/sidpalas/deputies/commit/6777695570437ac1ab41b2e117af8e8f9f25634b))

## [0.11.0](https://github.com/sidpalas/deputies/compare/v0.10.0...v0.11.0) (2026-06-16)


### Features

* add tensorlake sandbox provider ([#70](https://github.com/sidpalas/deputies/issues/70)) ([05e78e8](https://github.com/sidpalas/deputies/commit/05e78e896899761695f16ca927b40151bad48b68))


### Chores

* remove completed plans ([cfea6e8](https://github.com/sidpalas/deputies/commit/cfea6e8bf38efc9e0b3907ee739cc24fbc8d2c2a))


### Documentation

* add remote docker bridge backlog note ([92068fa](https://github.com/sidpalas/deputies/commit/92068fa80c86ad2d303857ff93a3e4000d4b86ff))
* **www:** add sandbox blog image variants ([0f21266](https://github.com/sidpalas/deputies/commit/0f21266500c304aaf6f73a7d14e8cbf00f7ebede))
* **www:** add sandbox provider article ([f3b08b1](https://github.com/sidpalas/deputies/commit/f3b08b16b10dfb4eeef4d296e6204ad52dd506b0))
* **www:** clarify sandbox state preservation patterns ([fbc68e2](https://github.com/sidpalas/deputies/commit/fbc68e26e9b198b6a967d7e6e662357af9b1e99e))


### Code Refactoring

* **control-plane:** extract app route modules ([c662d68](https://github.com/sidpalas/deputies/commit/c662d687824106d846425c4ddc669ecb388f5577))
* **control-plane:** rename sandbox service endpoint API ([6aabdfc](https://github.com/sidpalas/deputies/commit/6aabdfc70aa7315e51dd6b4e3864e2ea11470a06))
* reuse Pi find tool for sandbox operations ([#67](https://github.com/sidpalas/deputies/issues/67)) ([cf9bf48](https://github.com/sidpalas/deputies/commit/cf9bf483ba1cb8611263f53c7ca4a7dc8ab2c61d))

## [0.10.0](https://github.com/sidpalas/deputies/compare/v0.9.0...v0.10.0) (2026-06-12)


### Continuous Integration

* add deployment smoke workflow ([668f333](https://github.com/sidpalas/deputies/commit/668f333c416c8d5109e587ad3a2ba0c7d4906044))
* make compose smoke script executable ([92f9e36](https://github.com/sidpalas/deputies/commit/92f9e36a9032138042ea4f660e51fc0531d66111))
* match release please commit scope ([c5b386d](https://github.com/sidpalas/deputies/commit/c5b386d8d09b97d3548336179f15d0940e36caa2))
* skip tests on release commits ([2c7273e](https://github.com/sidpalas/deputies/commit/2c7273ef982c5c26ad74757adb57269165f48056))


### Features

* **control-plane:** compact finalized text deltas ([#61](https://github.com/sidpalas/deputies/issues/61)) ([1de90fb](https://github.com/sidpalas/deputies/commit/1de90fbc900c0b4099be185ce884ff373d80e6be))
* **control-plane:** configure daytona sandbox resources ([b89d2a7](https://github.com/sidpalas/deputies/commit/b89d2a7d722cce97c458b9cd1a96bfa15b5cd983))
* **control-plane:** support Deputies previews inside sandboxes ([#63](https://github.com/sidpalas/deputies/issues/63)) ([f53050b](https://github.com/sidpalas/deputies/commit/f53050b62551ef8bb759fb49ec033254d3cc25c0))


### Bug Fixes

* **control-plane:** clear high dependency audit advisories ([86ad0d5](https://github.com/sidpalas/deputies/commit/86ad0d5e05aa94998655d15231b9b1dbfe866992))
* **control-plane:** finalize stale runs with no recoverable messages ([b1a8b00](https://github.com/sidpalas/deputies/commit/b1a8b001f2598019b29b350b130d48434d86ad62))
* **control-plane:** use timing-safe generic webhook auth ([ad21838](https://github.com/sidpalas/deputies/commit/ad2183803acfdd1af260193f8a292832a3d4ecc8))
* **docker:** remove stale patches copy ([9c08b79](https://github.com/sidpalas/deputies/commit/9c08b793f56f6d974599f5fc85aa9ad46da9c86c))
* **sandbox-bridge:** harden preview proxy failures ([a3e8fd6](https://github.com/sidpalas/deputies/commit/a3e8fd68e0b779bbaea5cf6c3019e98ec5a2989b))
* **web:** preserve early events for new sessions ([#65](https://github.com/sidpalas/deputies/issues/65)) ([ae1dbd1](https://github.com/sidpalas/deputies/commit/ae1dbd1d1ff1e634b46d048f6235b60cca6860fe))


### Chores

* add eslint baseline ([fd46fe0](https://github.com/sidpalas/deputies/commit/fd46fe07da3f1a86d9dee6caf2a8f2d63e401969))
* align repo housekeeping docs and vitest ([9ce53b5](https://github.com/sidpalas/deputies/commit/9ce53b59c22a1a559b9286db0d8cf0887c8ce895))
* **control-plane:** upgrade flue runtime to 0.11.1 ([8c379cf](https://github.com/sidpalas/deputies/commit/8c379cf84d0c1ba1b070ed368e9a6ea35dc01aff))
* fix eslint baseline violations ([28573f6](https://github.com/sidpalas/deputies/commit/28573f6564f54fb579590f4d05eba6f6f48608be))


### Documentation

* clarify flue session fresh-start impact ([ddf29e4](https://github.com/sidpalas/deputies/commit/ddf29e44cc08796f73b6ce05f526e84e3035d74f))
* harden inner app preview runbook ([42ca671](https://github.com/sidpalas/deputies/commit/42ca671dca996d27d84731d3e63bb70c48e729c4))
* update implementation plan statuses ([01d7dea](https://github.com/sidpalas/deputies/commit/01d7dea0b020e46f40ac0ed3335bda83b0c415b5))


### Performance Improvements

* **control-plane:** page global event listing ([4454a5f](https://github.com/sidpalas/deputies/commit/4454a5f7b6ee4978fa882dbbcd9039a4c8d7fcce))
* **control-plane:** page session event replay ([f036c76](https://github.com/sidpalas/deputies/commit/f036c768174d26aa64ab2422fe8e01f5359325df))


### Code Refactoring

* **control-plane:** segregate store interfaces ([70be981](https://github.com/sidpalas/deputies/commit/70be981c3015aca487f4dc1b361a9b40cd13565f))
* **web:** extract access groups admin hook ([6a8695d](https://github.com/sidpalas/deputies/commit/6a8695dc2c0795756525eb8a7731b094d4ecae56))


### Tests

* **control-plane:** add cross-group access matrix ([2883cf4](https://github.com/sidpalas/deputies/commit/2883cf4b78cd3a35dd145e433ccd4734694daefc))
* **web:** make responsive e2e api mocks origin agnostic ([7f46408](https://github.com/sidpalas/deputies/commit/7f464080faddddf51d9528640904089d544db63a))

## [0.9.0](https://github.com/sidpalas/deputies/compare/v0.8.0...v0.9.0) (2026-06-11)


### Continuous Integration

* add run tests workflow ([#60](https://github.com/sidpalas/deputies/issues/60)) ([826b76b](https://github.com/sidpalas/deputies/commit/826b76b145b036a9adaf71a449dd30e159448d9c))
* update workflow release config ([755fd49](https://github.com/sidpalas/deputies/commit/755fd49451ac37401bdd32919c86c80ce269501d))


### Features

* add session readiness telemetry ([#57](https://github.com/sidpalas/deputies/issues/57)) ([0a67078](https://github.com/sidpalas/deputies/commit/0a670782ee3d13a0d434bb1ea886939f7f01ea95))


### Bug Fixes

* **control-plane:** expose instrumented store methods ([1decd61](https://github.com/sidpalas/deputies/commit/1decd61f6b1728e75abf12e431939ceb2fcb1509))
* include browser milestones package in docker builds ([d1cde8f](https://github.com/sidpalas/deputies/commit/d1cde8f77ae01852f0e6a80c9cd178c4d530d07c))


### Performance Improvements

* **control-plane:** cut hot-path database query load ([#59](https://github.com/sidpalas/deputies/issues/59)) ([0a3fa65](https://github.com/sidpalas/deputies/commit/0a3fa65c8b2da2d0fb231e7fc2622dfcc1934b69))
* **web:** decouple session detail from outputs ([37d721e](https://github.com/sidpalas/deputies/commit/37d721e2d02aa3e89e21c7fdb9f855c7e48cd08d))
* **web:** optimize heavy session rendering ([1b5f964](https://github.com/sidpalas/deputies/commit/1b5f964f6a5212cb53232d5eb74c9b0755e99e13))

## [0.8.0](https://github.com/sidpalas/deputies/compare/v0.7.0...v0.8.0) (2026-06-09)


### Features

* add scheduled automations ([#55](https://github.com/sidpalas/deputies/issues/55)) ([d64296e](https://github.com/sidpalas/deputies/commit/d64296e0b5658c8b3a5f4a70c03ef4fb4bb7b6f0))
* **web:** align access group creation flow ([00a40f0](https://github.com/sidpalas/deputies/commit/00a40f045c2ed2755396a61251d92374935f1461))


### Bug Fixes

* **web:** prevent mobile sidebar trigger overlap ([c8f7fa7](https://github.com/sidpalas/deputies/commit/c8f7fa72115750c539f8759e3b479d2ad676b504))

## [0.7.0](https://github.com/sidpalas/deputies/compare/v0.6.4...v0.7.0) (2026-06-08)


### Features

* **control-plane:** add web search tool ([a4553ef](https://github.com/sidpalas/deputies/commit/a4553efd434259b5f16ae4ba71cdf89ac93a161b))
* **www:** add blog image generator ([664c6d6](https://github.com/sidpalas/deputies/commit/664c6d659af5c187a889d712bfabf3e80be0e614))


### Chores

* fix formatting ([e4415b5](https://github.com/sidpalas/deputies/commit/e4415b5d94a0f2c8488fc9869f722a67f2c8af2d))
* upgrade pnpm to 11.5.2 ([e309e15](https://github.com/sidpalas/deputies/commit/e309e15d6cf441119b4a4e3e26538bede11314ec))

## [0.6.4](https://github.com/sidpalas/deputies/compare/v0.6.3...v0.6.4) (2026-06-05)


### Bug Fixes

* **container:** update vulnerable image dependencies ([7ba776e](https://github.com/sidpalas/deputies/commit/7ba776e10d54de013cdad1160eb0c7f0af5136e5))
* **web:** simplify chat scroll behavior ([da1cae8](https://github.com/sidpalas/deputies/commit/da1cae89035ddb5def9cc82a4f70f1bfd98e44f4))

## [0.6.3](https://github.com/sidpalas/deputies/compare/v0.6.2...v0.6.3) (2026-06-03)


### Bug Fixes

* **control-plane:** install GitHub CLI for Pi gh tool ([#49](https://github.com/sidpalas/deputies/issues/49)) ([e359eae](https://github.com/sidpalas/deputies/commit/e359eaec814ae1455874f9a46ebc7e4af57c286c))

## [0.6.2](https://github.com/sidpalas/deputies/compare/v0.6.1...v0.6.2) (2026-06-03)


### Bug Fixes

* **sandbox:** isolate agent command environments ([8c46eb1](https://github.com/sidpalas/deputies/commit/8c46eb185f10c05bd7ab23ff651bbc345c5ac406))
* **web:** batch deputy progress updates ([e7982ab](https://github.com/sidpalas/deputies/commit/e7982ab3be5f7a7b5bb8aac79fe0f4a5a531cd8c))

## [0.6.1](https://github.com/sidpalas/deputies/compare/v0.6.0...v0.6.1) (2026-06-03)


### Bug Fixes

* harden sandbox image builds ([#46](https://github.com/sidpalas/deputies/issues/46)) ([6f4d736](https://github.com/sidpalas/deputies/commit/6f4d7364170648c6cd7826a53d6e6903623c0c34))

## [0.6.0](https://github.com/sidpalas/deputies/compare/v0.5.0...v0.6.0) (2026-06-03)


### Features

* **docker-compose:** add 1password env injection ([3c49a64](https://github.com/sidpalas/deputies/commit/3c49a643f3b943747f5dae08b85810229c59cff0))


### Bug Fixes

* preview auth proxying through sandbox bridge ([#45](https://github.com/sidpalas/deputies/issues/45)) ([f17072f](https://github.com/sidpalas/deputies/commit/f17072f169775cff8b478c89dd8000e94f5c704d))
* **web:** disable static demo service links ([482256b](https://github.com/sidpalas/deputies/commit/482256b0385d8a8712c18b7e60246b766d9596e7))


### Chores

* **docker-compose:** add stack teardown tasks ([902f883](https://github.com/sidpalas/deputies/commit/902f883a9f283777eea85d1a954bd65c4e5817cd))

## [0.5.0](https://github.com/sidpalas/deputies/compare/v0.4.0...v0.5.0) (2026-06-01)


### ⚠ BREAKING CHANGES

* GitHub product login env vars changed. Removed AUTH_GITHUB_ADMIN_ORGANIZATIONS, AUTH_GITHUB_VIEWER_USERS, AUTH_GITHUB_VIEWER_ORGANIZATIONS, and UNSAFE_AUTH_GITHUB_ALLOW_ALL_VIEWERS. Use AUTH_GITHUB_ALLOWED_USERS, AUTH_GITHUB_ALLOWED_ORGANIZATIONS, AUTH_GITHUB_DEFAULT_GROUP_ROLE, and UNSAFE_AUTH_GITHUB_ALLOW_ALL instead.
* RUNNER_MODEL is removed; use RUNNER_MODEL_DEFAULT to configure the default runner model.

### Features

* add access groups rbac ([#41](https://github.com/sidpalas/deputies/issues/41)) ([22a1537](https://github.com/sidpalas/deputies/commit/22a1537a4e26efe793bce8d099175c1b583efcac))
* rename runner default model config ([3ab5b28](https://github.com/sidpalas/deputies/commit/3ab5b28357198afe02f4c2abda4c9c32c8e0a7bc))

## [0.4.0](https://github.com/sidpalas/deputies/compare/v0.3.0...v0.4.0) (2026-06-01)


### ⚠ BREAKING CHANGES

* Replace Flue-specific runtime config names with runner-oriented names: RUNNER_MODEL, RUNNER_MODEL_CHOICES, RUNNER_STATE_STORE, OPENAI_CODEX_AUTH_FILE, OPENAI_CODEX_AUTH_BASE64, and the /models modelChoices response field.

### Features

* add Deputies favicon ([690a0c8](https://github.com/sidpalas/deputies/commit/690a0c8f548deb43383a9e9317d88510b0a517e6))
* **control-plane:** add Pi runner ([#40](https://github.com/sidpalas/deputies/issues/40)) ([25b25f4](https://github.com/sidpalas/deputies/commit/25b25f4bd663fe98887bc78a827f65af5dde72e0))
* generalize runner model configuration ([3dfd869](https://github.com/sidpalas/deputies/commit/3dfd86917a827bdae23bfabe29b162add998353b))
* **www:** add Astro MDX blog ([aa99716](https://github.com/sidpalas/deputies/commit/aa997165a6cfa44544ee45322869757d2b95e471))
* **www:** add Deputies launch blog post ([e7ec362](https://github.com/sidpalas/deputies/commit/e7ec362b6bdc1f78c0c0dd63a06bc48b6993d410))
* **www:** add Twitter embed component ([0eb6e83](https://github.com/sidpalas/deputies/commit/0eb6e8321e8224d29aac1bb31f88239ec288f675))


### Bug Fixes

* harden github cli tool file access ([d74e0a5](https://github.com/sidpalas/deputies/commit/d74e0a5179b53be2b658c917d570a8e4e8954b8d))
* remove raw Codex auth JSON env ([e3f7769](https://github.com/sidpalas/deputies/commit/e3f7769b824993fe87cd367d239918053c6da19f))
* **web:** handle fast new-session responses ([84fc025](https://github.com/sidpalas/deputies/commit/84fc025aff5db21af1d72a0306223bc64c632dfa))
* **web:** render new session stream events before detail refresh ([#39](https://github.com/sidpalas/deputies/issues/39)) ([1ac9031](https://github.com/sidpalas/deputies/commit/1ac9031840f757ed73395800e5f88cea850d4a62))
* **www:** stabilize scrollbar gutter ([6e61574](https://github.com/sidpalas/deputies/commit/6e61574c2fa95673b14493ea167b96c31117f630))


### Chores

* **www:** remove subdir for template post ([7e57ec1](https://github.com/sidpalas/deputies/commit/7e57ec165000837d332f10514d2d5b7a7b0505ea))

## [0.3.0](https://github.com/sidpalas/deputies/compare/v0.2.0...v0.3.0) (2026-05-28)


### Features

* upgrade Flue runtime to 0.8.0 ([#37](https://github.com/sidpalas/deputies/issues/37)) ([d382a7d](https://github.com/sidpalas/deputies/commit/d382a7d7b150cf3170fdaddc339311943c9e0e36))


### Bug Fixes

* cancel queued messages when archiving sessions ([f45d8d6](https://github.com/sidpalas/deputies/commit/f45d8d638fb07e0b0f568e388a075580063bca6c))
* **www:** build static demo in Docker image ([d9dab0e](https://github.com/sidpalas/deputies/commit/d9dab0e81d0a652d738b538b68208f0e3267b8db))
* **www:** use package build command in Dockerfile ([894e600](https://github.com/sidpalas/deputies/commit/894e6002fc07237c8c7b5716705cab3faf6d99ca))


### Chores

* organize mise monorepo tasks ([#34](https://github.com/sidpalas/deputies/issues/34)) ([05176db](https://github.com/sidpalas/deputies/commit/05176dbcb7b4249ee51426f82509c71ea046e391))

## [0.2.0](https://github.com/sidpalas/deputies/compare/v0.1.1...v0.2.0) (2026-05-27)


### Features

* add Kubernetes agent sandbox provider ([#33](https://github.com/sidpalas/deputies/issues/33)) ([65d14f0](https://github.com/sidpalas/deputies/commit/65d14f0b0784ff83e21177eda59875eba9b87d0c))
* use signed preview auth cookies ([88a6873](https://github.com/sidpalas/deputies/commit/88a6873305dfe261792e667998cd32f0fd780389))


### Bug Fixes

* **web:** bound live streaming progress ([7cc9935](https://github.com/sidpalas/deputies/commit/7cc9935a61042f9e5dc099e1d33951041afe7bb2))


### Chores

* ignore chagelog from prettier ([42f5831](https://github.com/sidpalas/deputies/commit/42f5831c00ac9d4877be8e75c269b7ef350ba497))
* include chores in changelog ([7fa62cb](https://github.com/sidpalas/deputies/commit/7fa62cb280f344c2f16af1278e0b52218afe1c94))

## [0.1.1](https://github.com/sidpalas/deputies/compare/v0.1.0...v0.1.1) (2026-05-26)

### Bug Fixes

* use bump-minor-pre-major in release please ([585a500](https://github.com/sidpalas/deputies/commit/585a500ce592e7bed881fa0152339c215367b1ed))

## 0.1.0 (2026-05-26)

### Features

* add api bearer auth ([c079693](https://github.com/sidpalas/deputies/commit/c07969329e392bdd34fe3c947b689600869f5634))
* add artifacts and callbacks ([3f19fec](https://github.com/sidpalas/deputies/commit/3f19fecc24cfc2d00d1f7a79cb4087835df704ec))
* add core session API loop ([c8d28a6](https://github.com/sidpalas/deputies/commit/c8d28a692302c455ed0e8ca1b3a8f2bf98ffbb2c))
* add daytona sandbox provider ([a5ceddc](https://github.com/sidpalas/deputies/commit/a5ceddcacbc1f5d43867d8beaf3b74c318a58b75))
* add derived session display status ([e17aa23](https://github.com/sidpalas/deputies/commit/e17aa239951f1a671fb1cdb47f4ce0e487cd8a93))
* add durable worker loop ([e393143](https://github.com/sidpalas/deputies/commit/e393143a7f9f4d13910474ca4cb7dec1ea3dc2e6))
* add event streaming and uat ([f0ccd36](https://github.com/sidpalas/deputies/commit/f0ccd361f03089595f3f03e9a096cea7d4b3b5ba))
* add flue runner persistence seam ([81f6a7b](https://github.com/sidpalas/deputies/commit/81f6a7b58e28b269e6d8f59899ae968d840a8892))
* add generic webhook integration ([40cca7a](https://github.com/sidpalas/deputies/commit/40cca7a9a9a01264e4964b58e21d94fcbc0eb555))
* add gh tool PR create and edit support ([#3](https://github.com/sidpalas/deputies/issues/3)) ([118bd2f](https://github.com/sidpalas/deputies/commit/118bd2f22f52c8925a5a19a15114f911aa3afdef))
* add graceful shutdown ([0acca2b](https://github.com/sidpalas/deputies/commit/0acca2b5492c0aa3d459a7354aaffca6406671bb))
* add Kubernetes Helm deployment ([#28](https://github.com/sidpalas/deputies/issues/28)) ([3cbec87](https://github.com/sidpalas/deputies/commit/3cbec878b585765e9ea1a3ee48bd4e3354afe51d))
* add message author attribution ([a08f2d2](https://github.com/sidpalas/deputies/commit/a08f2d2beb8be82f1d7df0b5e3b2f6ed21137670))
* add operator web ui ([eee4a96](https://github.com/sidpalas/deputies/commit/eee4a96659d7f39945697326d2549165b9c06914))
* add postgres app store ([3d48239](https://github.com/sidpalas/deputies/commit/3d48239d7c9c19a397bfae9390efe30ed0271723))
* add readonly github roles ([53d0877](https://github.com/sidpalas/deputies/commit/53d0877ce0d2fd612431a6279b1e8660567d49de))
* add repo model and branch pickers ([307fa04](https://github.com/sidpalas/deputies/commit/307fa04529c9672399f0344700b384115ae00e1f))
* add session artifact reads ([8faa7da](https://github.com/sidpalas/deputies/commit/8faa7da570799429ac164f390d22c39c9f8803d8))
* add session login ([cebeed6](https://github.com/sidpalas/deputies/commit/cebeed655a1e7a0029b0c6ee333d511132ddbcbb))
* add setup guide ([47876cf](https://github.com/sidpalas/deputies/commit/47876cf81632e399e374a82e655e4757c589f364))
* add Slack inbound integration ([d10dc36](https://github.com/sidpalas/deputies/commit/d10dc36021683a112303e1687129ffafab20c18f))
* add Slack outbound callbacks ([522e08b](https://github.com/sidpalas/deputies/commit/522e08bf772d348d4140065cdc4cbb32b8c24ba4))
* add static session demo ([f14cac1](https://github.com/sidpalas/deputies/commit/f14cac19493285f8b69c57c6554f099ab473395c))
* add workspace tools ([adb27cc](https://github.com/sidpalas/deputies/commit/adb27ccb7b2112164efd1fc06b1d27fa093fb65e))
* add www architecture modes ([815d287](https://github.com/sidpalas/deputies/commit/815d28781b58a07734d97636afa842fba34307b5))
* add www landing page ([4dd2902](https://github.com/sidpalas/deputies/commit/4dd2902b0691ab86df8843ba7661f49d62288f22))
* **artifacts:** add optional object storage ([7eb2d96](https://github.com/sidpalas/deputies/commit/7eb2d96aabeafe5e90820eb1db9abc7447164f00))
* **artifacts:** support browser-playable video artifacts ([171bb76](https://github.com/sidpalas/deputies/commit/171bb7613160267d6bba4863b1f88f452b8ceafc))
* **artifacts:** timestamp storage keys ([bd8bf14](https://github.com/sidpalas/deputies/commit/bd8bf14a7bc2135fca3f4c91b4a0b283f9da4f46))
* batch queued session messages ([a6f27f1](https://github.com/sidpalas/deputies/commit/a6f27f154a73efa5d3e613496ed726cc43218860))
* cancel active session runs ([3109b35](https://github.com/sidpalas/deputies/commit/3109b35bad88062d59a494a54452cd0d5876bc0c))
* clarify landing page delegation flow ([60c843d](https://github.com/sidpalas/deputies/commit/60c843d4a4cb9a62a5ff3fd456fe360bb0316dc5))
* **deploy:** add local split compose mode ([f365940](https://github.com/sidpalas/deputies/commit/f3659404465c9916f7647d92d009b637c2596669))
* generalize previews as live services ([94ff085](https://github.com/sidpalas/deputies/commit/94ff085bac510143ed4c2a01c9b172be8770dcad))
* group session header tools ([5c86dbe](https://github.com/sidpalas/deputies/commit/5c86dbe6b2e1ac4841bfee3e5a61b74011eb0f76))
* harden json request handling ([f86e01e](https://github.com/sidpalas/deputies/commit/f86e01eb24cf664bdbbd3b05490ca83b6b6a299c))
* harden split worker deployment modes ([e9cf55f](https://github.com/sidpalas/deputies/commit/e9cf55f01a649d6fed267aab08c9d215364675d3))
* normalize flue live events ([f3cbb63](https://github.com/sidpalas/deputies/commit/f3cbb63676c504be2168632efa70a9ac7882c5e4))
* persist sandbox lifecycle ([a87376e](https://github.com/sidpalas/deputies/commit/a87376e014d11b74a66cff0b9543fd3298cef8ac))
* **previews:** add authenticated sandbox live previews ([545f616](https://github.com/sidpalas/deputies/commit/545f616615f9e0e24fb781a72903211630144b6e))
* reap idle session sandboxes ([ff327a8](https://github.com/sidpalas/deputies/commit/ff327a8444d2ddfbeaf4368eebb856362b2b665e))
* refine deputy sessions workspace ([7b699cd](https://github.com/sidpalas/deputies/commit/7b699cdc23b115777e43cde4650e042d68d9f567))
* refine deputy web ui ([8df8a05](https://github.com/sidpalas/deputies/commit/8df8a050162614f7af2aba9eaf9f99c349a47e44))
* refine www landing content ([c0cc50f](https://github.com/sidpalas/deputies/commit/c0cc50fb6de5b5ffc0abfbfe58f12cde28a9f28d))
* retry callbacks with Slack progress ([0e041ea](https://github.com/sidpalas/deputies/commit/0e041ea33626e8a5322fd7b0b498d4b9d0a1fc06))
* **slack:** send session link before completion ([032c4fd](https://github.com/sidpalas/deputies/commit/032c4fd5192396f608c5a6fd2a08b8876ff9a904))
* **slack:** show run progress with reactions ([f4e34d1](https://github.com/sidpalas/deputies/commit/f4e34d1530d38a8e11aba7b483e3d3d51e95f7ee))
* **slack:** use assistant thread status for progress ([e2025f5](https://github.com/sidpalas/deputies/commit/e2025f576a5f5c7bea90e46b6298444278a19452))
* support extending sandbox previews ([14df25d](https://github.com/sidpalas/deputies/commit/14df25d591a176421065043e7bc616065709b489))
* track pull requests as external resources ([ed4fa59](https://github.com/sidpalas/deputies/commit/ed4fa59f91299376392c83e1fa4a619d28672e89))
* verify setup connectivity ([69fdcaf](https://github.com/sidpalas/deputies/commit/69fdcafc1d5813968a363456ae8c13ead7f801b4))
* wire flue agent factory ([3411e9c](https://github.com/sidpalas/deputies/commit/3411e9c09f022b597f6f5250898aaf7e76ab0a6c))
* **www:** add built by footer ([480d0c2](https://github.com/sidpalas/deputies/commit/480d0c259b70bf1d47d2f767a6d2f14e90e37df7))
* **www:** add footer contact button ([86745b9](https://github.com/sidpalas/deputies/commit/86745b9e6d594251f196d63fba2ebf6d2f094416))
* **www:** add GoatCounter tracking ([b6ca93e](https://github.com/sidpalas/deputies/commit/b6ca93ebe102763f14b12379aa84dd15cdffe866))
* **www:** add open graph image ([6206332](https://github.com/sidpalas/deputies/commit/6206332eda4835e4b03776a8ce5f6128843062e2))
* **www:** add Railway deploy button ([054aeb8](https://github.com/sidpalas/deputies/commit/054aeb8e82a5c146c6323ba5275e9de87656d009))
* **www:** open demo sessions on mobile ([9e7dd27](https://github.com/sidpalas/deputies/commit/9e7dd2709d9cc7f31f36976ccac18078fcc1a556))

### Bug Fixes

* add browser logout route ([e0220fc](https://github.com/sidpalas/deputies/commit/e0220fcb2a1b2d34ce4cde792fb4623771af4397))
* add Docker CLI timeouts ([09df381](https://github.com/sidpalas/deputies/commit/09df381b56fa8b09e9303b776cfecc865f7b98fa))
* align composer enter behavior ([7d56e92](https://github.com/sidpalas/deputies/commit/7d56e92a862b1d04bfa22062999184759f2f8257))
* align merged worker tests ([3ad8f1b](https://github.com/sidpalas/deputies/commit/3ad8f1bb87e7517e3d76d2e5cb2da782ccb03cb3))
* align response schema contracts ([f598555](https://github.com/sidpalas/deputies/commit/f59855562a8473cd036ea71d2c4ea39c559e38cc))
* align www hero buttons ([e3d844e](https://github.com/sidpalas/deputies/commit/e3d844ee5e376273e64488757208cce548cfb10f))
* allow diagnostic panels to chain scroll ([7c7b43b](https://github.com/sidpalas/deputies/commit/7c7b43bbd3856683b564795c9983145732c088bc))
* allow flue transitive pi dependencies ([e129f14](https://github.com/sidpalas/deputies/commit/e129f14b566238a374de194a9e2f910695126b0d))
* allow viewers to inspect setup ([390d346](https://github.com/sidpalas/deputies/commit/390d34660e14b275264d452231642b8231ef2b9e))
* archive sessions optimistically ([e8e84b4](https://github.com/sidpalas/deputies/commit/e8e84b421f233993f0f60c1d3a7309186b449c0a))
* **auth:** complete GitHub login before redirecting ([486ca28](https://github.com/sidpalas/deputies/commit/486ca2867e64d0837a372ecf642ab983f4f23164))
* center mobile sidebar header button ([b057a2e](https://github.com/sidpalas/deputies/commit/b057a2eecf07a18e5886a35904e68b22d9672fb0))
* claim session queues without deadlocks ([9d89a9e](https://github.com/sidpalas/deputies/commit/9d89a9e9eed661c11745eb0bca6c4a01fd1f9805))
* clarify fake runner setup ([fa198be](https://github.com/sidpalas/deputies/commit/fa198be9eafaf99e136b2e8dd5eb4447a6568544))
* clarify readonly viewer state ([23edc3d](https://github.com/sidpalas/deputies/commit/23edc3d68b8e8846b5e12061fad28cbac49c3d35))
* clarify s3 artifact storage label ([1d45637](https://github.com/sidpalas/deputies/commit/1d4563730f6bfd881e8fdd497aaa82f642379898))
* clean up realtime stream resources ([#13](https://github.com/sidpalas/deputies/issues/13)) ([1f6b05d](https://github.com/sidpalas/deputies/commit/1f6b05dd8218eef05c8a426f1e235eedb7ca64cc))
* clean up sandboxes after create failures ([c848d66](https://github.com/sidpalas/deputies/commit/c848d660d7345566634aea80dc1220c38961e7ee))
* cleanly reject invalid service websocket upgrades ([d35cd06](https://github.com/sidpalas/deputies/commit/d35cd06ac6eea5d5ddf48710cb9dada6d80cd721))
* clear composer before submit refresh ([6837efd](https://github.com/sidpalas/deputies/commit/6837efd56a2e5982234e497ce9cea7066fd10e93))
* close mobile sidebar when starting new thread ([#1](https://github.com/sidpalas/deputies/issues/1)) ([6270ac6](https://github.com/sidpalas/deputies/commit/6270ac6f4d31584f1c72effceed65833cc725c33))
* compact static demo message input ([a3a6e90](https://github.com/sidpalas/deputies/commit/a3a6e90fdcf185a46859ba8dc6dee0289684dc47))
* constrain static demo iframe scrolling ([5ca02f8](https://github.com/sidpalas/deputies/commit/5ca02f8c7ea6c8cd369f3e68b8c46902510e7f4d))
* **control-plane:** shorten flue affinity keys ([d21d986](https://github.com/sidpalas/deputies/commit/d21d98630be7d4ad50de480dca78e0b764aab96e))
* defer streaming code highlighting ([4ce1127](https://github.com/sidpalas/deputies/commit/4ce1127242c3e7a76d6c89464e38b2b7c6c4c596))
* disable static demo workspace tools ([584c60f](https://github.com/sidpalas/deputies/commit/584c60f32e261e15781952ba074ee064118f99ed))
* expose sessions sidebar on new session mobile ([ffc1f65](https://github.com/sidpalas/deputies/commit/ffc1f6550d1a0624c1e23b0e238b9d282c96c206))
* expose unavailable model state ([f6eeef5](https://github.com/sidpalas/deputies/commit/f6eeef50ae78722006b004e2ef30942b244a0c3f))
* fence integration delivery processing ([2ad2394](https://github.com/sidpalas/deputies/commit/2ad239407c7110ce2673bfc36d48b859393cf432))
* finalize cancellation after worker abort ([1bde453](https://github.com/sidpalas/deputies/commit/1bde453244e2325caac9792012df87bf35761aa9))
* guard run work by active leases ([bc03ef6](https://github.com/sidpalas/deputies/commit/bc03ef67e58685df83b92c0b1b6bf418cb6fef9e))
* harden cookie auth and artifact downloads ([bf0d457](https://github.com/sidpalas/deputies/commit/bf0d457cc3317fd75faa9a32ceaea94cb69fbb77))
* harden HTTP completion callbacks ([3b11158](https://github.com/sidpalas/deputies/commit/3b11158327f16cc93c0c49f55b11e8dbf7e39ea9))
* harden viewer security edges ([40dcb2f](https://github.com/sidpalas/deputies/commit/40dcb2fb29db1ddb4ac971b773303d10855f50d5))
* hide jump control while composing ([7731ec6](https://github.com/sidpalas/deputies/commit/7731ec64bf11d491ab4b61b75cc690481e433496))
* improve mobile session archive controls ([#15](https://github.com/sidpalas/deputies/issues/15)) ([81695e6](https://github.com/sidpalas/deputies/commit/81695e66dde058fe5adade3be0cdd33f41db788e))
* improve scroll behavior ([ff43796](https://github.com/sidpalas/deputies/commit/ff43796dfa2f750203678e7a464d10b3d9095a60))
* increase static demo iframe height ([e57394b](https://github.com/sidpalas/deputies/commit/e57394bb3b19ae314d840f8ea1194fbc21df5d0e))
* inject worker artifact service ([0127b12](https://github.com/sidpalas/deputies/commit/0127b129c2384a6b77519ba8ad594575587aecc5))
* isolate session title edits ([1e7fce1](https://github.com/sidpalas/deputies/commit/1e7fce1dffba4dc205ecf4446efee89bf45ce61e))
* keep cancel run button compact ([ed66ee6](https://github.com/sidpalas/deputies/commit/ed66ee65484eb9733522a5e3175db457301e8ad4))
* keep Enter as newline on mobile ([#12](https://github.com/sidpalas/deputies/issues/12)) ([5b4016e](https://github.com/sidpalas/deputies/commit/5b4016e0f67264b3812f56407925b051bbb78035))
* keep only one context picker open ([784c2ef](https://github.com/sidpalas/deputies/commit/784c2efdd6827d35c29c56e75dc66942692f4033))
* keep text input responsive ([b9c12d5](https://github.com/sidpalas/deputies/commit/b9c12d52aceeca07d709d96ecf7eb69c55852d4c))
* label unmatched diagnostics as started ([9385691](https://github.com/sidpalas/deputies/commit/938569149607489431ff18740f4e0a4912d38bc0))
* light mode code snippet readability ([#10](https://github.com/sidpalas/deputies/issues/10)) ([3a3f33e](https://github.com/sidpalas/deputies/commit/3a3f33e1984ca074c9e2f07e423f12c38fa793c8))
* make markdown tables scroll on mobile ([5d86ce5](https://github.com/sidpalas/deputies/commit/5d86ce5ff1d12b9d3a690eb6be152a16beffb514))
* make SSE replay backpressure safe ([874dab7](https://github.com/sidpalas/deputies/commit/874dab71dff39b55bd706b4eaed363d8a809562c))
* mark sessions queued for pending messages ([e298fea](https://github.com/sidpalas/deputies/commit/e298feae11257bbf96715d68ac864973745478af))
* match hero button heights ([1187ef2](https://github.com/sidpalas/deputies/commit/1187ef2737c6490dfa47090ed0f88e07ee2e274e))
* merge latest services before publishing ([33697e9](https://github.com/sidpalas/deputies/commit/33697e98278f3830039fb67529190a5bd12a4341))
* move mobile sidebar control into session header ([6d418da](https://github.com/sidpalas/deputies/commit/6d418daf7dbccfe78eaef2853d7dfb0da4cae842))
* persist sandbox secrets securely ([2c95fa4](https://github.com/sidpalas/deputies/commit/2c95fa4e817ca0fc6360dfe192f08721958b5672))
* place mobile session actions above header ([#11](https://github.com/sidpalas/deputies/issues/11)) ([02bd639](https://github.com/sidpalas/deputies/commit/02bd63938a652d6dab7c68b0c4633f78f37b05c2))
* polish readonly demo controls ([571f811](https://github.com/sidpalas/deputies/commit/571f811fb28673b3ed100d5986cd0024a55d6449))
* preserve services when publishing ([6321263](https://github.com/sidpalas/deputies/commit/6321263fc3d482364726d2282a5f9c1271e5cf53))
* prevent duplicate create-submission in session compose ([#2](https://github.com/sidpalas/deputies/issues/2)) ([d621cde](https://github.com/sidpalas/deputies/commit/d621cdebba0f1888447c6368a8544cf31a7f9f57))
* prevent reconnect banner layout shift ([#19](https://github.com/sidpalas/deputies/issues/19)) ([9b5e508](https://github.com/sidpalas/deputies/commit/9b5e50886b9ed8fb9bb0a8f945c3ea6ed1ba9977))
* **previews:** harden local sandbox preview routing ([b36efb9](https://github.com/sidpalas/deputies/commit/b36efb945093845e07e13957ad9be8b1fa221715))
* reconnect desktop event streams ([4c5e462](https://github.com/sidpalas/deputies/commit/4c5e462755225672959fd2aa48907321a428eaae))
* resolve inherited follow-up model ([2b1a4cd](https://github.com/sidpalas/deputies/commit/2b1a4cdaaf4e80dfb3b57e0d7a25c0c92e02781a))
* restore sessions optimistically ([3cb23ee](https://github.com/sidpalas/deputies/commit/3cb23ee72bc9fd4aa2d2be9710ae2c88eb535633))
* rotate archived sessions caret ([a2393e1](https://github.com/sidpalas/deputies/commit/a2393e138f86c3a70672c94633f9864c6f70ddd4))
* send persisted callback artifacts ([47b7b26](https://github.com/sidpalas/deputies/commit/47b7b266055e1cb87856d2cef51380298a504075))
* show mock workspace tools in static demo ([9c0ede4](https://github.com/sidpalas/deputies/commit/9c0ede453425804be36ee48e88ce034479a4823b))
* show readonly composer in static demo ([e451b6d](https://github.com/sidpalas/deputies/commit/e451b6d37c48f78d27f2e4dc97dcd38b74da34af))
* skip husky prepare in production ([d687e07](https://github.com/sidpalas/deputies/commit/d687e07dcf815b70cd16306aa36ed7a89a1b3ce5))
* **slack:** mark failed runs with x ([e3516e7](https://github.com/sidpalas/deputies/commit/e3516e7986310767ed1f95aec70f1f652c87fac1))
* **slack:** notify on cancelled runs ([53c097e](https://github.com/sidpalas/deputies/commit/53c097ea69519b70b884fcf7a6fc1362d30f7346))
* stabilize hunk diff workspace tool ([dd1895f](https://github.com/sidpalas/deputies/commit/dd1895f368b944d3c69c09b54361eaa0a572a58a))
* strengthen architecture boundaries ([0f0ccb2](https://github.com/sidpalas/deputies/commit/0f0ccb2ff2c09725dbf357da8102b6668c5211c8))
* support docker preview websocket services ([5aa657b](https://github.com/sidpalas/deputies/commit/5aa657bd0b22261a2e5702579c1c5934a6f8e559))
* support local TLS previews ([a7cf5bc](https://github.com/sidpalas/deputies/commit/a7cf5bc2157d8bd4a77dc9d108b74d61e4528d51))
* trust service websocket origins ([d29fdb0](https://github.com/sidpalas/deputies/commit/d29fdb0c2c9290cc43184aa3bd4741963dd78d05))
* update caddyfiles ([eb4fbfc](https://github.com/sidpalas/deputies/commit/eb4fbfc1b529bce659299f98ad3b134d2d6850a1))
* use real header in static demo ([3529e50](https://github.com/sidpalas/deputies/commit/3529e503cd8f4d2f40aca0b69cb431018e1e783c))
* validate generic webhook repositories ([726943f](https://github.com/sidpalas/deputies/commit/726943f40b0ad691e52daad45586ac18acae5969))
* wake worker loop on queued messages ([#18](https://github.com/sidpalas/deputies/issues/18)) ([a4eaf21](https://github.com/sidpalas/deputies/commit/a4eaf21f37631062a1777f2810b56c6f61c2723f))
* **web:** blur composer before clearing submitted text ([#14](https://github.com/sidpalas/deputies/issues/14)) ([3613d87](https://github.com/sidpalas/deputies/commit/3613d87e53520e724af11b19b0c52506a8ec9ff3))
* **web:** cap diagnostic event output ([d6538c5](https://github.com/sidpalas/deputies/commit/d6538c52117db93333e99a29d66ea351e0de1ca0))
* **web:** constrain long diagnostic output ([81b0062](https://github.com/sidpalas/deputies/commit/81b00623eebc310672d20a99841b1f9a68b191d7))
* **web:** disable autocomplete on message inputs ([145cfbb](https://github.com/sidpalas/deputies/commit/145cfbb1287b039d720c902c8df1d8e45a9665cb))
* **web:** handle local Slack deep links ([54c9b5f](https://github.com/sidpalas/deputies/commit/54c9b5f66900dd113bce2e2c1e4520a3777ec637))
* **web:** hide context sidebar sooner ([#23](https://github.com/sidpalas/deputies/issues/23)) ([ae85f15](https://github.com/sidpalas/deputies/commit/ae85f1590769c69a8d1e6e3ff2d1c92e6060a070))
* **web:** improve mobile composer submit ([367df4b](https://github.com/sidpalas/deputies/commit/367df4bf9b15899335aed95bbd615b9333f576d9))
* **web:** keep mobile sidebar footer reachable ([675572c](https://github.com/sidpalas/deputies/commit/675572c6594ec962b39b3eb018dbe7e4cc6fc2b2))
* **web:** pause chat autoscroll while composing ([488123a](https://github.com/sidpalas/deputies/commit/488123a19d4441420bf8312a7f4a3880fd621721))
* **web:** render diagnostics as readable activity ([828c69b](https://github.com/sidpalas/deputies/commit/828c69b30c8f1e8a93663c6c920071b1a82d4439))
* **web:** replay global session updates ([2950e7c](https://github.com/sidpalas/deputies/commit/2950e7c066f24e91da613452ae364eb682e3d369))
* **web:** show loading state when switching sessions ([578d9d3](https://github.com/sidpalas/deputies/commit/578d9d3b5faf63201c9f25b6842a968185a40435))
* **web:** stabilize streaming deputy progress ([cb83b0c](https://github.com/sidpalas/deputies/commit/cb83b0c6c9bd89e95056363d7cf72a891dc9f5de))
* **web:** suppress mobile credential suggestions ([ab6d2fc](https://github.com/sidpalas/deputies/commit/ab6d2fce4865b9f72a7e053aff5e52c8ad6d9816))
* **www:** link external references ([d4a7d1c](https://github.com/sidpalas/deputies/commit/d4a7d1c3da6ed910ea4b77b951660f554b30c2ae))
* **www:** normalize section spacing ([812f9b6](https://github.com/sidpalas/deputies/commit/812f9b6ba49e3152b85f29e13c02e24eff0def2c))
* **www:** widen FAQ cards ([f76fc21](https://github.com/sidpalas/deputies/commit/f76fc2166cf242361fb3f7c5924ef55c5815e3cc))

### Reverts

* remove autocomplete workaround ([2a3cc0e](https://github.com/sidpalas/deputies/commit/2a3cc0e393e8d193774ba9bea4fdff846fd2abc8))
