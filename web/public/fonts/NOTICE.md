# Embedded fonts

This directory ships self-hosted web fonts so that the live terminal and
ANSI tile preview render Powerline / Nerd Font / Unicode glyphs correctly
on every device, regardless of which fonts the user has installed locally.

## JetBrainsMono Nerd Font Mono

- Files: `JetBrainsMonoNerdFontMono-Regular.woff2`,
  `JetBrainsMonoNerdFontMono-Bold.woff2`
- Base typeface: JetBrains Mono — Copyright 2020 The JetBrains Mono Project
  Authors (https://github.com/JetBrains/JetBrainsMono). Licensed under the
  SIL Open Font License, Version 1.1 (see `LICENSE-fonts.txt`).
- Glyph patches: Nerd Fonts (https://github.com/ryanoasis/nerd-fonts),
  Copyright (c) 2014 Ryan L McIntyre, MIT licensed.

The "Mono" variant is the monospace patch (every glyph is single-cell wide),
which is what xterm.js requires to keep its character grid aligned.
