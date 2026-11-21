# Velvet Send components

The component catalogue in full: props, spacing numbers and accessibility rules. It moved here, verbatim, from [ai-design-guidelines.md](ai-design-guidelines.md), which keeps the one-line catalogue. Components live in `packages/mobile/src/components/`; each has a story (`dev/stories/<id>`) showing its states. Reach for these before hand-rolling a heading, a row, a pill or a placard.

## `ShelfHeader`

**`ShelfHeader`** `{ title, caption?, action?: { label, onPress, accessibilityLabel? }, trailing?, testID? }`:
the heading of a shelf of content (Home's sections, the picker's groups). Title 3 emphasized, a
VoiceOver heading, at the 16pt gutter with no minimum height; "See all" is accent text and a chevron
that reaches its tap target through its own padded box. The title keeps at least 70% of the row: at large text
sizes the action wraps under it instead. **`ShelfSection`** takes the same props plus `children`
and owns the spacing: 8pt from the header to the content, 28pt to the next shelf.

## `TextAction`

**`TextAction`** `{ label, onPress, accessibilityLabel?, chevron?, reach?: 'even' | 'up' | 'down', testID? }`:
a borderless accent text button that adds no height to its row; padding handed back by a negative margin
brings its target to 44pt on Liquid Glass and 48dp on Material (not `hitSlop`: on Fabric a parent
hit-tests its children only inside its own bounds, unless their layout overflows it). ShelfHeader's
action, and the Retry after a quiet `EmptyState`. `reach` says where the extra height goes: `even`
(the default) splits it, `up` and `down` reach only 4pt toward the other side. Stack two actions and
lean them apart, or the lower target is drawn over the upper one and takes its taps: ShelfHeader's
action leans `up`, an action leading a shelf's content leans `down` (4 + 4 fits the 8pt gap, even
with the header's action wrapped under its title), and an action closing a shelf leans `up`, away
from the next header's.

## `InsetGroupedList`

**`InsetGroupedList`** `{ children, separatorInset?: 'regular' | 'compact' | 'gutter', testID? }`: the
inset-grouped `Card`. Rows run to its edges and own the 16pt gutter; it draws a hairline between
rows, inset to where their text starts, and clips them to its corners. A row that isn't an `ArtRow`
builds from `insetGroupedRowStyles` (`row`, a 44pt `leading` column, `text`).

## `ArtRow`

**`ArtRow`** `{ art, artSize: 'compact' | 'regular' | 'large', title, titleVariant?: 'headline' | 'body', subtitle?, eyebrow?, status?, accessory?:
'checkmark' | 'chevron' | element, selected?, onPress?, onLongPress?, delayLongPress?,
longPressAccessibilityLabel?, accessibilityLabel?, wrapTarget?, testID? }`: a row of an `InsetGroupedList` that
leads with art (a board, a playlist, an icon). The slot is 36, 44 or 72pt wide (`large`, 72×92, for a climb whose holds must read, such as Home's projects shelf) and the art sets the
height; memoise `art` in the caller. Headline title (12pt above and below, 4pt to the subtitle: Home's
rows), or with `titleVariant="body"` a list to choose from: a body title, regular until selected, 10pt above
and below and 2pt to the subtitle (the board picker). Secondary subheadline subtitle, footnote eyebrow; a `status` pill wraps under the title when the two don't fit on one line. `selected` takes
`theme.selection` (the selection wash behind the row, the title emphasized in label, an accent
checkmark) and reports `selected` to assistive tech. An element accessory (a ⋯ button) is drawn
beside the row's target, not inside it, so screen readers focus it and its tap is its own. The long
press is also a `longpress` accessibility action; give it `longPressAccessibilityLabel` or VoiceOver
leaves it out. `wrapTarget` wraps the row's own target and never the element accessory: a hold
menu's anchor goes there (the picker's board rows), so the ⋯ keeps its own tap. Presses dip in
opacity, never scale.

## `StatusPill`

**`StatusPill`** `{ label, tone?: 'neutral' | 'positive' | 'warning', icon?, testID? }`: something you can't
tap ("Following", "Ready to review"). `theme.status` fill and label, caption 1 emphasized; `positive` and
`warning` tint with the semantic green or orange at 15%, never the brand violet. An optional 12pt `icon`
leads the label. It never shrinks or truncates, so put it beside text that can (`ArtRow`'s `status`).

## `EmptyState`

**`EmptyState`** `{ title, body?, actions?, size: 'screen' | 'section' | 'quiet', icon?, testID? }`:
"nothing here". `screen` fills and centres (an empty tab or pane), `section` centres inside a longer
page with 32pt above and below, `quiet` is one secondary footnote line at the gutter with a trailing
`TextAction` and no body or icon, for a shelf that came back empty.

## `BoardThumbnail`

**`BoardThumbnail`** (`components/boards/`) `{ board: { boardType, layoutId, sizeId, setIds }, size:
'compact' | 'regular' | 'large' | number, accessibilityHidden? }`: a board's bare art in a 36×44, 44×56 or 72×92 slot
(or a square of `size` points). The art keeps its own aspect ratio with a `separator` hairline on it
and no tile behind it; an unknown config shows the boards glyph and a spray wall shows its cached
photo, or a camera glyph until the photo is on disk. It renders at 400px so it shares the raster
cache with board discovery. `BoardThumbnailView` is the same slot with the art passed in, for
stories.
