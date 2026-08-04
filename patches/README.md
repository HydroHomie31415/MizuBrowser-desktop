# Firefox source patches

Put patches for existing upstream files in this directory. Files ending in
`.patch` are applied in lexical order by `./mizu sync`. A patch that is already
applied is skipped. If a patch can neither be applied nor cleanly reversed,
sync stops so an upstream conflict cannot pass unnoticed.

Prefer the overlay for new product-owned files. Keep patches small and add an
upstream bug or rationale in each patch header.

A new patch must not add lines between another patch's context lines, even
though it applies in order and builds. Sync recognises an applied patch by
reversing it, and a patch whose context has been split can no longer be
reversed, so the next sync stops on it. In practice this means adding to a list
just outside the three lines of context around an earlier Mizu entry rather
than immediately beside it, which is why a few additions are not where sorting
would put them. Run `./mizu sync` twice after adding a patch: the second run
has to report every patch as already applied.

