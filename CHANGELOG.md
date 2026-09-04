# Changelog

## [0.3.0](https://github.com/chrischall/myatriumhealth-mcp/compare/v0.2.0...v0.3.0) (2026-09-04)


### Features

* one response rung for every reader — `view` replaces `compact` ([#27](https://github.com/chrischall/myatriumhealth-mcp/issues/27)) ([7062b34](https://github.com/chrischall/myatriumhealth-mcp/commit/7062b3443238e6334eae64f950f5608a93186f3d))
* read a proxy patient's chart, not just the account holder's ([#23](https://github.com/chrischall/myatriumhealth-mcp/issues/23)) ([0d9227f](https://github.com/chrischall/myatriumhealth-mcp/commit/0d9227fe7ad9d0e821ff3e3f3609be18637c549a))
* **tools:** compact by default — strip media URLs, and minify every response ([#21](https://github.com/chrischall/myatriumhealth-mcp/issues/21)) ([3f3284a](https://github.com/chrischall/myatriumhealth-mcp/commit/3f3284a6115bbbd7f34356bbf387bd3a712d1910))


### Bug Fixes

* **deps:** mcp-utils 0.23.1, so compact strips camelCase media keys ([#29](https://github.com/chrischall/myatriumhealth-mcp/issues/29)) ([f488292](https://github.com/chrischall/myatriumhealth-mcp/commit/f4882928412fb324336e6658dd361646c5e5ef49))
* read a .env, so configured credentials actually select bridge-less mode ([#25](https://github.com/chrischall/myatriumhealth-mcp/issues/25)) ([b8311ad](https://github.com/chrischall/myatriumhealth-mcp/commit/b8311ad39f77a7b82a1067de032bf86b0e98a5c5))
* **tools:** actually minify, and pick up @chrischall/mcp-utils 0.23.2 ([#31](https://github.com/chrischall/myatriumhealth-mcp/issues/31)) ([1a6bb46](https://github.com/chrischall/myatriumhealth-mcp/commit/1a6bb4670caab61b18cc6c592c6f06de14808114))
* use the library's string-aware walk to read the patient switcher ([#30](https://github.com/chrischall/myatriumhealth-mcp/issues/30)) ([759405e](https://github.com/chrischall/myatriumhealth-mcp/commit/759405ebe3d4b86b64ab7a1c1cea0530560c2779))


### Documentation

* an idle session is what was measured, not a lifetime ([#20](https://github.com/chrischall/myatriumhealth-mcp/issues/20)) ([5f1fd18](https://github.com/chrischall/myatriumhealth-mcp/commit/5f1fd18dac13f0e22031e5a5d8c2b09e3d90ca53))
* put a measured ceiling on the MyChart session lifetime ([#18](https://github.com/chrischall/myatriumhealth-mcp/issues/18)) ([3b07501](https://github.com/chrischall/myatriumhealth-mcp/commit/3b0750159149031518d3620ad5317549e3074908))

## [0.2.0](https://github.com/chrischall/myatriumhealth-mcp/compare/v0.1.1...v0.2.0) (2026-09-04)


### Features

* collect credentials per connector user, with the MFA flow inline ([#15](https://github.com/chrischall/myatriumhealth-mcp/issues/15)) ([4e5c034](https://github.com/chrischall/myatriumhealth-mcp/commit/4e5c03457c2c96775d6d3073e4e0f2284861419c))


### Bug Fixes

* persist the jar when a challenge is raised, so a code survives a restart ([#14](https://github.com/chrischall/myatriumhealth-mcp/issues/14)) ([a75bb64](https://github.com/chrischall/myatriumhealth-mcp/commit/a75bb642236b4c20b4a470f9c6be6cf8f018ce73))

## [0.1.1](https://github.com/chrischall/myatriumhealth-mcp/compare/v0.1.0...v0.1.1) (2026-09-04)


### Bug Fixes

* mint.yaml described the bridge-only server that no longer exists ([#12](https://github.com/chrischall/myatriumhealth-mcp/issues/12)) ([1230ede](https://github.com/chrischall/myatriumhealth-mcp/commit/1230ede02359f2876a18ad194a879f3ee6c286ca))

## 0.1.0 (2026-09-03)


### Features

* bridge-less sign-in with human-in-the-loop verification ([#8](https://github.com/chrischall/myatriumhealth-mcp/issues/8)) ([5142f03](https://github.com/chrischall/myatriumhealth-mcp/commit/5142f032661ecc7e55d5d7b81444b68b8682a18c))
* MyAtriumHealth (Epic MyChart) records via the browser bridge ([561b791](https://github.com/chrischall/myatriumhealth-mcp/commit/561b791d95b92b97ebad569f9cf8b74dfef8f209))
* read care team providers and billing accounts ([#4](https://github.com/chrischall/myatriumhealth-mcp/issues/4)) ([05c5372](https://github.com/chrischall/myatriumhealth-mcp/commit/05c537260f8d2911e270b9c90d7f58936d35e68e))
* read Message Center conversations and insurance coverages ([#1](https://github.com/chrischall/myatriumhealth-mcp/issues/1)) ([dab96fb](https://github.com/chrischall/myatriumhealth-mcp/commit/dab96fb00713bb68194cb203c2c7208518847f72))


### Bug Fixes

* persist rotated cookies, clear a stale challenge flag, stop promising a skip ([#10](https://github.com/chrischall/myatriumhealth-mcp/issues/10)) ([7caaa68](https://github.com/chrischall/myatriumhealth-mcp/commit/7caaa6813d87e4e3a645b368829ea267a883056d))
* recognise a verification challenge as needing sign-in ([#6](https://github.com/chrischall/myatriumhealth-mcp/issues/6)) ([0b222c9](https://github.com/chrischall/myatriumhealth-mcp/commit/0b222c901f5f7055e31cced410e5fac1d5b79e32))
* report message participants, and guard shell helpers on empty tokens ([#5](https://github.com/chrischall/myatriumhealth-mcp/issues/5)) ([555aba2](https://github.com/chrischall/myatriumhealth-mcp/commit/555aba205fa1e133402a1cf1997c22114b924d34))
