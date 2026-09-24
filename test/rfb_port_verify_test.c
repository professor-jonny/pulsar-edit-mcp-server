/* Test fixture for replace-function-body port verification (note [39]) */

int simpleTarget(int x) {
    return x + 999;
}

/*
 * A deliberately large doc comment block, several lines long, to check
 * whether the parked read/inFunction anomaly (note [37]) reproduces via
 * matchFunction's own resolveSymbolPosition-adjacent path.
 *
 * param y - input value
 * returns the doubled value
 */
int docCommentTarget(int y, int scale) {
    return y * scale;
}

int scopeDup(int a) {
    return a + 100;
}

int betweenAnchorA(void) {
    return 1;
}

int scopeDup(int a) {
    return a + 200;
}

int betweenAnchorB(void) {
    return 2;
}
