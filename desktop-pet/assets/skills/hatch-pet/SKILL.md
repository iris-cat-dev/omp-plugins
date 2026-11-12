---
name: hatch-pet
description: Create and install a custom animated desktop pet for OMP from a description or reference images, using the configured image-generation tool and the included local installation helper.
---

# Create an OMP desktop pet

Use this plugin-provided skill in the author workspace opened by **Settings > Plugins > Desktop pet > Configure > Create with OMP**. It is copied into this workspace's `.omp/skills/hatch-pet/`, not installed as a global skill. Keep authoring files in that workspace. Do not overwrite plugin-provided pets, the user's other skills, or existing custom pet packages.

## Confirm the character

Use the user's description and any attached reference images. If no description was supplied, ask what creature, style, and personality they want before generating art. `iris-reference.png` is an optional example, not permission to substitute Iris for the requested character.

Create a complete independent companion, not an Iris reskin. Derive its visual identity, voice, bubble palette/shape, and speaking rhythm from the user's brief. Author its own `bubble` profile for every supported state, including intentional silence. Do not reuse Iris's pink bubble, stock status text, or work-chatter lines as the new pet's personality. Keep short messages readable at pet size and in the user's language; task-state dialogue must not falsely claim that work succeeded or was approved.

Use OMP's configured `generate_image` tool. Do not introduce a different cloud service, credentials, subscription, or hardcoded model. If image generation is unavailable, explain the missing image-model configuration; do not claim a pet was created or manufacture a placeholder.

## Generate a real animation atlas

Generate **a coherent animation frame sequence**, not a collection of unrelated poses. A suitable default is a 1536 × 1024 atlas: twelve columns of 128 × 128 tiles, six action rows at the top, and two completely empty padding rows at the bottom. Each action row is a twelve-frame temporal loop. Keep character identity, proportions, lighting, scale, registration point, and bottom baseline identical across frames. Move limbs, ears, eyelids, and props gradually; make the last frame join the first without a jump. Leave clear padding so nothing crosses tile boundaries. No grid lines, text, logos, or scene backgrounds.

Prefer a canonical character reference followed by state-specific frame strips grounded in that same reference. Use deterministic local image processing to extract, align, and assemble the approved generated frames; do not assume the image model obeyed the requested cell boundaries. Do not synthesize missing poses by copying or geometrically transforming one still. The [OpenAI hatch-pet workflow](https://github.com/openai/skills/blob/main/skills/.curated/hatch-pet/SKILL.md) is a useful reference for this separation of generation, assembly, contact-sheet review, and motion-preview QA; its fixed Codex atlas and package fields are not OMP's format.

Choose one grid before generating and keep the image, manifest, and animation counts consistent. The default above is **12 columns × 8 rows**, with only rows 0–5 animated. It is not a runtime-wide fixed frame size: the plugin-provided Iris pet uses a separate **3840 × 960** atlas with **24 columns × 6 rows of 160 × 160** frames. Do not copy Iris's manifest onto a default-size generated image, or change its frame dimensions merely to match this example.

Request transparent background. If the image tool cannot produce transparency, request a perfectly flat **#00FF00 chroma-key green** background, with no green inside the character. The helper removes this green automatically. If the requested pet itself is green, use transparency rather than chroma-key.

Action rows, each a coherent temporal loop using the chosen frame count (twelve for the default):

1. `idle`: breathing, looking around, a natural blink.
2. `running`: working/focused, with a small action or typing motion.
3. `needs_input`: curious or expectant, asking for attention.
4. `ready`: a happy completion/wave.
5. `blocked`: worried or confused, without disturbing flashing.
6. `dragging`: being carried, leaning gently.

Inspect the actual atlas before installation, including adjacent frames and the loop seam. Fix character drift, abrupt pose changes, missing intermediate frames, missing rows, incorrect dimensions, cut-off body parts, overlapping frames, or incorrect backgrounds. Regenerate inconsistent sequences; do not disguise four unrelated still pictures with duplicated frames or a slideshow crossfade. The generated file may be PNG, JPEG, or WebP; pass its actual returned path to the helper rather than guessing its extension.

## Write `pet.json`

The following manifest illustrates the default 1536 × 1024, 128 × 128, twelve-frame layout and a complete bubble profile. Personalize the name, description, appearance, **every state's dialogue and timing** for the new character; the example is not a finished personality. Verify all frame dimensions, rows, and frame counts against the **actual decoded image and visible tile layout**. For another layout, update those fields together rather than copying this example unchanged.

```json
{
  "version": 1,
  "name": "The user's pet name",
  "description": "A concise description of the finished character",
  "spritesheet": "sprites.png",
  "frameWidth": 128,
  "frameHeight": 128,
  "animations": {
    "idle": { "row": 0, "frames": 12, "fps": 12 },
    "running": { "row": 1, "frames": 12, "fps": 12 },
    "needs_input": { "row": 2, "frames": 12, "fps": 12 },
    "ready": { "row": 3, "frames": 12, "fps": 12 },
    "blocked": { "row": 4, "frames": 12, "fps": 12 },
    "dragging": { "row": 5, "frames": 12, "fps": 12 }
  },
  "bubble": {
    "appearance": {
      "background": "#EEF4FF",
      "foreground": "#23344D",
      "border": "#6987B3",
      "shape": "rounded",
      "fontSize": 12,
      "fontWeight": "normal",
      "padding": 9,
      "borderRadius": 12,
      "maxWidth": 220,
      "animation": "fade"
    },
    "states": {
      "idle": {
        "messages": ["我在这里，慢慢来。"],
        "delayMs": 15000,
        "durationMs": 3500,
        "repeatDelayMs": 45000
      },
      "offline": {
        "messages": ["连接暂停了，我先安静陪着你。"],
        "delayMs": 0,
        "durationMs": 4000,
        "repeatDelayMs": 0
      },
      "running": {
        "messages": ["让我专心把这一步做好。", "还在处理，我会盯紧进展。"],
        "delayMs": 2000,
        "durationMs": 4000,
        "repeatDelayMs": 30000
      },
      "needs_input": {
        "messages": ["这里需要你的决定。"],
        "delayMs": 0,
        "durationMs": 0,
        "repeatDelayMs": 0
      },
      "ready": {
        "messages": ["结果送到，请你过目。"],
        "delayMs": 0,
        "durationMs": 5000,
        "repeatDelayMs": 0
      },
      "blocked": {
        "messages": ["这一步遇到了阻碍，一起看看吧。"],
        "delayMs": 0,
        "durationMs": 0,
        "repeatDelayMs": 0
      },
      "dragging": { "messages": [], "delayMs": 0, "durationMs": 0, "repeatDelayMs": 0 },
      "petted": {
        "messages": ["收到你的鼓励了。"],
        "delayMs": 0,
        "durationMs": 2500,
        "repeatDelayMs": 0
      }
    }
  }
}
```

A different atlas size is allowed only when the manifest matches its actual grid:

- Image width must be divisible by `frameWidth`; image height must be divisible by `frameHeight`.
- Each animation's `frames` must fit within `image width / frameWidth`, and its zero-based `row` must be less than `image height / frameHeight`. Count genuine frames; padding cells are not animation frames.
- Inspect the visible cell boundaries and character registration as well as the pixel dimensions. Arithmetic bounds alone cannot detect a wrongly described grid or inconsistent poses.
- The installation helper converts the image format and background; it **does not resize, retile, or create intermediate frames**. Changing numbers in `pet.json` does not transform the image. Correct or regenerate a mismatched atlas before installation.

All five non-dragging states are required; `dragging` is optional. The image must be a decodable transparent PNG no larger than 20 MiB and 4096 × 4096 pixels after conversion. Packages contain only data, not scripts or executable UI.

OMP adds continuous subtle breathing/sway and click reactions locally. Idle, waiting, completion, and blocked sequences play intermittently with quiet pauses rather than looping constantly; working and dragging loops continue. System reduced-motion preferences show a static pose. Use enough genuine in-between frames for fluid motion; longer or higher-resolution sequences are allowed within the atlas limits.

## Define this pet's bubble behavior

New image-based creation requires the complete `bubble` profile. Existing installed packages without it remain readable, but do not omit it from a newly authored pet.

- All eight state rules are required. `messages: []` explicitly means silent, not “fall back to Iris.” Messages are plain text, at most 24 per state and 180 characters each; use much shorter lines for readability. There are no HTML, CSS, script, or model-call templates.
- `delayMs` delays first appearance after a real state/event entry. `durationMs: 0` stays visible until the state/event changes; positive values hide the line after that duration. Both are integers from 0 to 60000.
- `repeatDelayMs: 0` means no repetition. Otherwise wait 1000–3600000 ms **after hiding**, then rotate to the next line. A repeating rule needs a positive duration. `petted` is a one-shot interaction, so its `repeatDelayMs` must always be 0.
- The highest-priority actual task determines `needs_input`, `blocked`, `ready`, or `running`; otherwise use `idle` or `offline`. Repeated unchanged snapshots do not restart dialogue. Dragging temporarily takes priority. A timed `petted` response may outlast the touch animation, but a new task state interrupts stale speech. A silent petting rule suppresses speech for the gesture and resumes the base state on release.
- Appearance colors accept only `#RRGGBB` or `#RRGGBBAA`. Choose `speech`, `rounded`, or `thought`; `fontSize` 10–20, `fontWeight` `normal`/`bold`, `padding` 6–16, `borderRadius` 0–28, and `maxWidth` 120–320. The overlay also clamps text to the available viewport.
- Entry animation is `none`, `fade`, or `pop`; system reduced-motion preferences disable these transitions. Runtime speech uses only the authored local rules and does not call a model.

Before accepting the result, inspect a contact sheet and motion previews of every used animation, then exercise this pet's bubble states. Reject neighboring-frame slivers, clipped bodies, inconsistent face/scale/baseline, copied stills, unreadable text, inherited stock dialogue, and incorrect appearance/hide/repeat timing. Geometry validation alone is not visual acceptance.

## Install and prove success

Run the included helper from this workspace, passing the generated image path:

- **Windows:** explicitly invoke `cmd.exe /d /c install-pet.cmd "<actual image path>"`.
- **macOS/Linux:** `./install-pet.sh '<actual image path>'`.

The helper runs the installed Desktop pet plugin's own converter and installer with OMP Desktop's bundled Electron in Node mode; it does not launch the GUI or call a Desktop pet-install command. No global Node.js or Python installation is needed. Keep the plugin installed with its runtime dependencies while using the helper. It converts the actual PNG, JPEG, or WebP image to PNG, removes green from opaque chroma-key images, validates the manifest/atlas, and atomically installs a uniquely identified package in the local pet library. Transparent images retain their original colors, including green characters. It does not replace plugin-provided Iris or change the user's current selection.

Do not report success unless the command exits with code zero and prints the installed pet descriptor, including its name and ID. Correct validation failures before retrying; never suppress them. Keep the completed authoring workspace so the user can refine the pet later.

After successful installation, tell the user to return to **Settings > Plugins > Desktop pet > Configure**, click **Refresh**, and select the new pet. Selecting it while the pet is enabled updates the live companion. Creating artwork uses the configured image model; ordinary animation and task-status updates do not call a model. Existing authoring workspaces keep their copied instructions and scripts; open a new **Create with OMP** workspace for this plugin-owned helper.
