// The gym map inside the board picker's modal stack, so Near you's Map ›, In
// range's Search gyms and Manage boards' + push it on top of the picker with a
// back chevron. The root copy pushed from inside the picker would be presented
// as a second sheet (docs/mobile/mobile-sheets-vs-routes.md, "Same-navigator
// modal inheritance"). The screen draws its map card and list here, not the
// full-screen map with its draggable panel.
export { default } from '../gyms/index';
