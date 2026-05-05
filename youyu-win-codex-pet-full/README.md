# Youyu Windows Codex Pet Pack

This package contains the full rich spritesheet set for a Windows Codex desktop pet.

## Files

- `main-spritesheet.webp`: production main atlas.
- `extra-spritesheet.webp`: production extra-state atlas.
- `main-spritesheet.png`: PNG debug copy of the main atlas.
- `extra-spritesheet.png`: PNG debug copy of the extra atlas.
- `spritesheet-manifest.json`: frame size, rows, states, frame counts, and source keys.
- `qa/main-spritesheet-checker.png`: checkerboard QA preview.
- `qa/extra-spritesheet-checker.png`: checkerboard QA preview.
- `qa/all-candidates-checker.png`: extracted candidate overview.
- `tools/build_rich_pet_pack.py`: reproducible build script used to create this pack.

## Runtime Spec

- Frame size: `192 x 208`
- Main atlas size: `1536 x 1872`
- Extra atlas size: `1536 x 1040`
- Background: transparent
- Recommended runtime format: WebP
- PNG copies are included for inspection and fallback.

Read `spritesheet-manifest.json` instead of assuming every row has 8 active frames.
Transparent empty cells are padding and should not be played.

## States

Main atlas:

- `idle`
- `walkRight`
- `walkLeft`
- `wave`
- `jump`
- `drag`
- `sleepWake`
- `focusWait`
- `happy`

Extra atlas:

- `edgePeek`
- `fallRecover`
- `annoyed`
- `comfortSad`
- `rewardObserve`

## Integration Notes

- Use alpha hit testing for the pet window so transparent areas do not capture input.
- Let non-looping states return to `idle`.
- Use `walkLeft` and `walkRight` only while moving the window.
- Treat `rewardObserve` as holding or observing a reward, not eating.
- The character has no visible mouth by design.
