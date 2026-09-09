import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export default class Driver extends Extension {
    enable() {
        this.pointer = global.stage.get_context().get_backend().get_default_seat().create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        this.object = Gio.DBusExportedObject.wrapJSObject(`<node><interface name="org.stepforge.Test">
            <method name="Click"><arg type="i" direction="in"/><arg type="i" direction="in"/></method>
            <method name="Screenshot"><arg type="s" direction="in"/></method>
            <method name="HideOverview"/>
            <method name="Move"><arg type="i" direction="in"/><arg type="i" direction="in"/></method>
            </interface></node>`, this);
        this.object.export(Gio.DBus.session, '/org/stepforge/Test');
    }
    HideOverview() { Main.overview.hide(); }
    Move(x, y) { this.pointer.notify_absolute_motion(GLib.get_monotonic_time(), x, y); }
    async ScreenshotAsync([path], invocation) {
        const stream = Gio.File.new_for_path(path).replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        await new Shell.Screenshot().screenshot(false, stream);
        stream.close(null);
        invocation.return_value(null);
    }
    Click(x, y) {
        this.pointer.notify_absolute_motion(GLib.get_monotonic_time(), x, y);
        // Virtual motion is queued on Mutter's input thread. Wait for it to
        // settle before clicking, just as a user positions the pointer first.
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
            this.pointer.notify_button(GLib.get_monotonic_time(), 1, Clutter.ButtonState.PRESSED);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 40, () => {
                this.pointer.notify_button(GLib.get_monotonic_time(), 1, Clutter.ButtonState.RELEASED);
                return GLib.SOURCE_REMOVE;
            });
            return GLib.SOURCE_REMOVE;
        });
    }
    disable() {
        this.object?.unexport();
        this.pointer = null;
    }
}
