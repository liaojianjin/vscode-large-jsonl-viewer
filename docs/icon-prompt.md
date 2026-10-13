# Extension icon

Created on 2026-10-09 and edited on 2026-10-10 and 2026-10-14 using the built-in `image_gen` tool. Final project asset: `assets/icon.png` (1254 × 1254 RGBA PNG, 943,402 bytes).

The JSON braces and record lines represent JSONL records; the magnifying glass represents inspection and navigation. The high contrast mark is designed for extension lists and store pages.

## Generation prompt

Use case: logo-brand. Asset type: a production PNG icon for the VS Code extension 'Large JSONL Viewer'. Create ONE square standalone app icon, 1024 by 1024, designed to remain clearly recognizable at 32px and 128px. A bold, simple symbol combining JSON curly braces, a few horizontal record lines with one selected line, and a compact magnifying-glass motif to convey inspecting one JSONL record in a huge file. Keep the symbol integrated and uncluttered, use thick geometric strokes and generous negative space. Clean contemporary developer-tool styling, restrained high-contrast colors on a dark rounded-square tile, crisp flat shapes with only subtle polish. Centered front-on composition with safe padding. The icon must fill the canvas as an icon asset, not appear in a scene or mockup. No words, letters, labels, numbers, watermark, screenshots, perspective, tiny detail, or photographic textures.

Original generation: transparent background was false.

## Transparency edit prompt

Use case: background-extraction / precise-object-edit. Edit target: the attached existing Large JSONL Viewer extension icon. Change ONLY the solid black background OUTSIDE the dark navy rounded-square tile into genuine transparency (PNG alpha). Preserve the entire navy rounded-square tile and everything INSIDE it: same cyan JSON curly braces, all horizontal record bars including the blue selected bar, the white magnifying glass, their exact positions, scale, colors, strokes, highlights, and overall composition. The dark navy areas inside the rounded tile and inside the magnifying glass must remain opaque. Keep the original square canvas, proportions, and framing. Clean antialiased rounded outer edges. Do not redraw, recolor, enlarge, crop, add text, add drop shadows, or remove the internal navy background. Outside the rounded tile must be actual transparent pixels, not white, black, or a baked checkerboard pattern.

Edit setting: transparent background true. PNG decoding verified alpha 0 at all four corners and alpha 252–253 at representative interior points (the navy tile remains visually solid). The tool output is used directly, without further raster editing.

## Store-size edit prompt (2026-10-14)

Use case: precise-object-edit. Edit this existing Large JSONL Viewer icon into a small-file-size extension-store PNG asset. Output a square 256x256 PNG, not a mockup. Preserve the same dark navy rounded-square tile, cyan JSON braces, the same horizontal record bars with a selected blue bar, and the white magnifying glass with the same layout and silhouette. Keep actual alpha transparency ONLY outside the rounded tile. The interior navy tile and shapes should be opaque. To make PNG compression excellent, use clean FLAT solid fills, no texture, no fine grain, no dithering, no noise, no elaborate gradients, no photographic shading. Keep crisp antialiased edges. Do not add text, logos, symbols, shadows or elements. This must be optimized as a tiny UI icon and remain recognizable at 32 pixels; intended final PNG file size well below 1 MiB.

The tool returned a 1254 × 1254 PNG. Its IDAT stream was recompressed losslessly with zlib level 9, keeping all decoded image data and other PNG chunks unchanged. Final size is below the Marketplace's 1 MiB limit.
