#include <stdlib.h>
// Owned C frame remains present in the app dSYM after linking.
void boardsesh_diagnostics_abort(void) { abort(); }
