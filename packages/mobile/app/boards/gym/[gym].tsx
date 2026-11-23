// The gym page inside the board picker's modal stack, so a push from the picker
// lands on top of it with a back chevron to the picker. A push to the root copy
// from inside the modal would go to a different navigator
// (docs/mobile/mobile-sheets-vs-routes.md, the cross-navigator trap).
export { default } from '../../gyms/[gym]';
