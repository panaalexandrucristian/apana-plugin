---
tags: [assess-complexity]
max_turns: 20
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill]
---

I have to move 4 classes from an Android application into a separate module (a repository, a use case, a data source and a generic base). Details from the plan: 2 Hilt modules have to be touched, ~26 tests depend on them, the base is inherited by 3 subclasses in the app module, there are 3 build types (debug, beta, release), the data source runs on a single-thread dispatcher with a 2000 ms timer and a 1200 ms grace period, and the "native" activation for overview, content and event has no design yet. Determine the complexity of the plan before I implement it. I do not have access to the code right now, use only the description.
