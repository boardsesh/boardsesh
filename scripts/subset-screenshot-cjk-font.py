"""Regenerate pinned Chinese caption fonts; see presentation/fonts/README.md.

Run with fontTools 4.60.1 against the documented upstream font. This is an asset
maintenance tool, not a build dependency. It retains ASCII and all Chinese
caption characters, and gives the modified subsets an explicit family name.
"""

import hashlib
import json
import sys
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools import subset
from fontTools.varLib.instancer import instantiateVariableFont

root = Path(__file__).resolve().parents[1]
if len(sys.argv) != 2:
    raise SystemExit('Usage: subset-screenshot-cjk-font.py /path/to/NotoSansSC-variable.ttf')
font_source = Path(sys.argv[1])
expected_sha256 = 'a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da'
assert hashlib.sha256(font_source.read_bytes()).hexdigest() == expected_sha256, 'Unexpected upstream font bytes'
captions = json.loads((root / 'app-stores/presentation/zh-CN.json').read_text())
characters = set(range(0x20, 0x7F))
for caption in captions.values():
    for sentence in caption.values():
        characters.update(ord(character) for character in sentence if ord(character) >= 0x20)
font = TTFont(font_source, recalcTimestamp=False)
missing = characters - set(font.getBestCmap())
assert not missing, sorted(missing)
options = subset.Options()
options.name_IDs = ['*']
options.name_languages = ['*']
subsetter = subset.Subsetter(options=options)
subsetter.populate(unicodes=sorted(characters))
subsetter.subset(font)
for weight, style in [(400, 'Regular'), (700, 'Bold')]:
    instance = instantiateVariableFont(font, {'wght': weight}, inplace=False)
    instance.recalcTimestamp = False
    instance['OS/2'].usWeightClass = weight
    instance['OS/2'].fsSelection = (instance['OS/2'].fsSelection & ~0x60) | (0x20 if weight == 700 else 0x40)
    instance['head'].macStyle = 1 if weight == 700 else 0
    family = 'Boardsesh Screenshot CJK'
    names = {1: family, 2: style, 3: f'BoardseshScreenshotCJK-{style}', 4: f'{family} {style}', 6: f'BoardseshScreenshotCJK-{style}', 16: family, 17: style}
    for name_id, label in names.items():
        instance['name'].removeNames(nameID=name_id)
        instance['name'].setName(label, name_id, 3, 1, 0x409)
        instance['name'].setName(label, name_id, 1, 0, 0)
    destination = root / f'app-stores/presentation/fonts/NotoSansSC-{style}.ttf'
    instance.save(destination)
    actual = TTFont(destination).getBestCmap()
    assert characters <= set(actual)
    print(f'{destination.name}: {destination.stat().st_size} bytes, {len(characters)} required codepoints covered')
