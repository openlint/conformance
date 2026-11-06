# OpenLint Conformance

Does a linter do what the [OpenLint specification](https://spec.openlint.org/) says, and does the same ruleset give the same results everywhere? This project runs two suites every day against the latest release of [OpenLint](https://github.com/openlint/openlint), [Spectral](https://github.com/stoplightio/spectral), [vacuum](https://github.com/daveshanley/vacuum), the [IBM OpenAPI Validator](https://github.com/IBM/openapi-validator), [Insomnia's inso CLI](https://github.com/Kong/insomnia) and [Redocly CLI](https://github.com/Redocly/redocly-cli). It publishes the results at **[conformance.openlint.org](https://conformance.openlint.org/)**.

It's a standalone project on purpose. OpenLint is one of the implementations under test, not the owner of the results.

## The two suites

**Specification tests.** These are the [conformance tests](https://spec.openlint.org/v1/draft/#conformance-tests) published with the specification, in [openlint/spec `v1/conformance`](https://github.com/openlint/spec/tree/main/v1/conformance). There are 240 today. Each test is data: a ruleset, usually a document, and the expected outcome. Each one names the requirements it checks, for example `/req/functions/xor`. This project is the runner; the tests themselves belong to the spec. To dispute a test, open an issue on [openlint/spec](https://github.com/openlint/spec/issues).

**Interop cases.** These are extra cases in [`cases/`](cases/) that compare tools on common rules. They include tools that can't read Spectral or OpenLint rulesets. A case can carry a `redocly.yaml`, which expresses the same rule in Redocly's configurable-rules format. Because those files are translations, a Redocly result measures whether Redocly *can express and detect the same problem*, not whether it runs the same ruleset.

## Results

| Result | Means |
|---|---|
| **exact** | The outcome the test expects: every expected result matched (code, path, severity, message, range, as the test specifies), with nothing extra; or the ruleset accepted or rejected as expected |
| **detected** | The same rules fired the same number of times, but some detail differs, such as the path, message or range |
| **fail** | Different results, or a ruleset accepted that should be rejected (or the reverse) |
| **error** | The tool couldn't run a test that it should be able to run |
| **unsupported** | Outside the tool's scope: an OpenAPI-only linter given another kind of document, or a rule format that can't express the test |

Tool behaviour the runner accounts for:
- **vacuum and the IBM validator only lint OpenAPI documents.** Many specification tests use plain YAML, because the spec is format-agnostic. Those tests show as unsupported for these two tools.
- **The IBM validator, given an invalid ruleset,** reports the problem and then lints with IBM's own default ruleset, exiting 0. The runner counts the report as a rejection.
- **inso has no JSON output.** Its text output is parsed instead. The npm `insomnia-inso` package is years out of date, so CI installs the latest binary from Kong's releases.

## Run it

```
npm run tools   # installs the latest openlint, spectral, vacuum, redocly and the IBM validator
                # inso: install the latest binary from github.com/Kong/insomnia/releases (see the workflow)
git clone https://github.com/openlint/spec
npm test        # writes results/matrix.json and results/matrix.md
```

`node run.mjs --spec <path to v1/conformance> --bin <dir with the tool binaries>` overrides the defaults. A GitHub Action runs both suites daily and on every push, and publishes `site/` with the latest `matrix.json`.

## Adding a tool

Write an adapter in `run.mjs` that runs the tool on a ruleset and a document and returns Spectral-model results (`code`, `path`, `severity`, `message`, `range`, `source`). If the tool rejects the ruleset, the adapter throws `Rejected`; if the test is outside the tool's scope, it throws `Unsupported`. Tool maintainers are welcome to contribute or correct their own adapter.

## License

[Apache-2.0](LICENSE)
