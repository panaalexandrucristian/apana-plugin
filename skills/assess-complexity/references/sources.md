# Sources and limits

| Source | How much was read | What it supports | Limits |
|---|---|---|---|
| [Cynefin.io wiki](https://cynefin.io/wiki/Cynefin) (2021 version, modified 16.04.2023) | in full, PDF | Cynefin = a decision-support framework, not a method; the domains are not quadrants; the transitions matter | gives no metrics or thresholds |
| O'Connor & Lepmets, ICSSP 2015, [DCU](https://doras.dcu.ie/20770/) | in full, PDF, 5 pages | classification by cause-effect (obvious / analyzable beforehand / only in retrospect / invisible); complicated = sense-analyse-respond, complex = probe-sense-respond; teams implicitly treat everything as complicated | position paper, no empirical validation, references mostly blogs; gives no code metrics |
| [TechTarget, Cynefin in agile](https://www.techtarget.com/searchsoftwarequality/tip/Agile-project-management-using-the-Cynefin-framework) (Francino, 2012) | in full | Cynefin qualitative, by judgment; different situations can be in different domains | trade press, account of a meetup |
| [TeaRAGs, Code Quality Metrics](https://artk0de.github.io/TeaRAGs-MCP/knowledge-base/code-quality-metrics) | in full | hotspot = complexity × change frequency; instability Ce/(Ce+Ca); CRAP threshold 30 | a literature synthesis by a project; the figures are cited indirectly, primary sources not read |
| [Fixify, Software architecture metrics](https://www.fixify.it.com/blog/software-architecture-metrics) | in full, from a saved PDF | vocabulary: cyclomatic (<10 per function, as an example), Ca/Ce, cognitive load | a blog without sources; does NOT contain the instability formula (that one is from TeaRAGs) |
| [Deakin a2i2, 2017](https://a2i2.deakin.edu.au/2017/11/02/complexity/) | not at all: 404 | - | the claim "complicated = maintaining a large codebase" is unverified; do not rely on it |

## Bottom line

No source read gives a numeric threshold for the complexity of a refactoring change. That is why the skill asks for a reasoned judgment from the code and forbids invented scores.
