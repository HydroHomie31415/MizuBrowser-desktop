# Firefox source patches

Put patches for existing upstream files in this directory. Files ending in
`.patch` are applied in lexical order by `./mizu sync`. A patch that is already
applied is skipped. If a patch can neither be applied nor cleanly reversed,
sync stops so an upstream conflict cannot pass unnoticed.

Prefer the overlay for new product-owned files. Keep patches small and add an
upstream bug or rationale in each patch header.

