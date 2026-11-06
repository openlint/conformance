# OpenLint Conformance

Does the same ruleset give the same results in every linter? This suite runs a set of cases against the latest release of [OpenLint](https://github.com/openlint/openlint), [Spectral](https://github.com/stoplightio/spectral) and [vacuum](https://github.com/daveshanley/vacuum), and publishes the matrix at **[conformance.openlint.org](https://conformance.openlint.org/)**.

It's a standalone project on purpose. OpenLint is one of the implementations under test, not the owner of the results. Any linter that implements the [OpenLint ruleset specification](https://spec.openlint.org/) can be added.

## How a case works

```
cases/<area>/<case>/
  ruleset.yaml     the ruleset under test
  document.yaml    the document it runs against
  expected.json    {"description": "...", "expected": [{"code": "...", "path": "..."}]}
```

A case is data, not code. The runner passes each case to an adapter per tool. The adapter maps that tool's output to the Spectral result model (`code`, `path`) and compares it with `expected.json`:

| Result | Means |
|---|---|
| **exact** | The same rule codes at the same paths |
| **detected** | The same number of results per rule, reported at a different path. A missing `summary` can fairly be reported at the operation or at `summary`. |
| **fail** | Different results |
| **error** | The tool couldn't run the case |

## Run it

```
npm run tools   # installs the latest openlint, spectral and vacuum
npm test        # writes results/matrix.json and results/matrix.md
```

A GitHub Action runs the suite daily and on every push, and publishes `site/` with the latest `matrix.json`.

## Status

This is an early prototype with 14 cases. The expected results are written by hand and agree with Spectral. Until each case cites the requirement it tests in the specification, the suite measures agreement with Spectral, not conformance to the spec. Making every case traceable to a MUST or SHOULD is the next piece of work. Where the spec is silent, that becomes a spec issue.

Planned coverage:
- every core function;
- `given` semantics (JSONPath Plus vs RFC 9535 JSONPath);
- `extends` and its modes, `overrides`, formats, `resolved: false`, and severity mapping;
- custom functions;
- ruleset discovery;
- real rulesets against real documents.

## Contributing

Add a case, or dispute an expected result, by opening an issue or pull request. Tool maintainers are especially welcome: if a case expects something your tool reasonably does differently, say so, and we'll take it to the specification.

## License

[Apache-2.0](LICENSE)
