# Changelog

## [0.4.2](https://github.com/chrischall/myatriumhealth-mcp/compare/v0.4.1...v0.4.2) (2026-09-10)


### Bug Fixes

* **deps:** @fetchproxy/server 2.10.0 and @chrischall/mcp-utils 0.26.1 ([#46](https://github.com/chrischall/myatriumhealth-mcp/issues/46)) ([f06ee47](https://github.com/chrischall/myatriumhealth-mcp/commit/f06ee47fdc22bf44bdfe2c08643d2c409db3cc3f))
* **deps:** declare the peer floors mcp-utils 0.26.1 requires ([#48](https://github.com/chrischall/myatriumhealth-mcp/issues/48)) ([e27899c](https://github.com/chrischall/myatriumhealth-mcp/commit/e27899c6697bba3cd80ab3ff4b0bddfb9ef71d17))

## [0.4.1](https://github.com/chrischall/myatriumhealth-mcp/compare/v0.4.0...v0.4.1) (2026-09-10)


### Bug Fixes

* **manifest:** the healthcheck stopped being bridge-specific two releases ago ([#44](https://github.com/chrischall/myatriumhealth-mcp/issues/44)) ([065b3cc](https://github.com/chrischall/myatriumhealth-mcp/commit/065b3cc3b036926c4d12e0f8a1a95ae5ad9eabd9))

## [0.4.0](https://github.com/chrischall/myatriumhealth-mcp/compare/v0.3.0...v0.4.0) (2026-09-10)


### Features

* **deps:** mcp-utils 0.26.0, and name the remedy tools instead of deriving them ([#43](https://github.com/chrischall/myatriumhealth-mcp/issues/43)) ([5c056f8](https://github.com/chrischall/myatriumhealth-mcp/commit/5c056f8e8e3ffc0a264b72de10d51744020cdd1d))
* one healthcheck, and a tool surface that does not follow the environment ([#39](https://github.com/chrischall/myatriumhealth-mcp/issues/39)) ([fa4cb4a](https://github.com/chrischall/myatriumhealth-mcp/commit/fa4cb4abfac7d905a39eb35e42fe56739f52573e))


### Bug Fixes

* **deps:** bump node-html-parser from 9.0.3 to 9.0.4 in the production-dependencies group ([#37](https://github.com/chrischall/myatriumhealth-mcp/issues/37)) ([d0201a2](https://github.com/chrischall/myatriumhealth-mcp/commit/d0201a25790fc933e7978e66471a40eb4c99490f))
* **healthcheck:** report a refused credential over a pending code, from one shared ladder ([#42](https://github.com/chrischall/myatriumhealth-mcp/issues/42)) ([bfd2718](https://github.com/chrischall/myatriumhealth-mcp/commit/bfd2718c6fedba5c3477261d4e50f99a5e36d801))
* **healthcheck:** report the hop that actually broke, not that the fetch resolved ([#40](https://github.com/chrischall/myatriumhealth-mcp/issues/40)) ([dd9dfc1](https://github.com/chrischall/myatriumhealth-mcp/commit/dd9dfc16e9da0baab2c65884a1cd3c0810631ae1))

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
