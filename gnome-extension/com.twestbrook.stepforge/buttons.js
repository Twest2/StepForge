// Pure state machine, shared with the Node behavioral tests. Mutter consumes
// native-client events before Clutter captured-event handlers see them. Read
// the compositor's button state instead; do not grab or reinject input.
export class Buttons {
    constructor(mask = 0) {
        this.mask = mask;
    }

    update(mask) {
        const pressed = mask & ~this.mask;
        this.mask = mask;
        // Clutter BUTTON1/2/3_MASK; discard keyboard modifier bits entirely.
        return [1, 2, 3].filter(button => pressed & (1 << (7 + button)));
    }
}
