# Render AST performance

Run `node scripts/profile-render-ast.js` from the repository root. The profile
creates a temporary real GuideStore with 100, 250 and 500 steps, each with a
1280×720 screenshot, rich descriptions, placeholders, annotations and
text/code/table blocks. All data is local and removed on completion.

The decision threshold is 50 ms of main-process event-loop blocking. The
synchronous profile measures 15 warm AST builds per size, both complete and
with the three-step preview limit. A queued timer measures the blocked event
loop. The background profile runs five actual quality-check jobs through the
existing export helper and measures excess delay of a 5 ms main-process
heartbeat. This measures responsiveness, not display frame rates.

Initial isolated profile on Windows, Node 24.22.1, AMD Ryzen 7 9800X3D:

| Guide steps | Full AST median | Three-step preview AST median | Largest full-AST timer delay |
| ---: | ---: | ---: | ---: |
| 100 | 81.18 ms | 80.62 ms | 86.24 ms |
| 250 | 206.53 ms | 203.47 ms | 219.53 ms |
| 500 | 400.39 ms | 400.52 ms | 426.22 ms |

`maxSteps` currently limits the output after AST construction, so it does not
reduce the work of reading and normalizing all steps. These stalls justify
moving the remaining AST calls off the main process.

Exports already build the AST and render output in a forked Node helper.
Guide quality checks, Wiki.js default title expansion and export previews now
reuse that helper. Quality and title jobs skip image decoding and return only
their findings or title, avoiding a large AST transfer. Preview jobs preserve
the selected brand, placeholders, image preparation and preview step limit.
The fixed-size branding sample remains in process.

A confirmation run under concurrent unit-test load measured background
heartbeat excess delays of 11.43, 14.21 and 14.93 ms for 100, 250 and 500 steps.
Total quality-job medians were 362, 592 and 839 ms, including process startup,
store loading and the quality scan. The helper improves main-process
responsiveness; it adds startup overhead and does not promise faster total
rendering. Hardware, antivirus and filesystem caches affect these values.

A separate worker-thread runtime would duplicate the existing export helper
and its image-codec setup. Reusing the existing process boundary addresses
the measured stalls with less lifecycle complexity. Tests compare actual
background exports, previews, quality findings and expanded titles with the
synchronous outputs. Linux desktop frame-rate testing remains a manual check.
