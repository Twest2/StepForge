import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {Buttons} from './buttons.js';

const PATH = '/org/stepforge/Capture';
const IFACE = 'org.stepforge.Capture1';
const XML = `<node><interface name="${IFACE}">
  <method name="GetInfo"><arg type="s" direction="out"/></method>
  <method name="Start"><arg type="s" direction="out"/></method>
  <method name="Stop"/>
  <signal name="Click"><arg type="s"/></signal>
  <signal name="Stopped"><arg type="s"/></signal>
</interface></node>`;

export default class StepForgeCapture extends Extension {
    enable() {
        this._owner = null;
        this._timer = 0;
        this._watch = 0;
        this._indicator = null;
        this._object = Gio.DBusExportedObject.wrapJSObject(XML, this);
        this._object.export(Gio.DBus.session, PATH);
        this._monitorsSignal = Main.layoutManager.connect('monitors-changed', () =>
            this._stop('Display layout changed. Restart recording and share the updated monitors.'));
    }

    GetInfo() {
        const [x, y] = global.get_pointer();
        const window = global.display.get_focus_window();
        const rect = window?.get_frame_rect();
        const app = window ? Shell.WindowTracker.get_default().get_window_app(window) : null;
        return JSON.stringify({
            protocol: 1, source: 'gnome-shell-sampled', sampleMs: 4, recording: Boolean(this._owner),
            pointer: {x, y},
            window: rect ? {x: rect.x, y: rect.y, width: rect.width, height: rect.height} : null,
            appName: app?.get_name() ?? '', windowTitle: window?.get_title() ?? '',
            windowPid: window?.get_pid() ?? 0,
        });
    }

    StartAsync(_args, invocation) {
        const owner = invocation.get_sender();
        if (this._owner && this._owner !== owner) {
            invocation.return_dbus_error(`${IFACE}.Busy`, 'Another StepForge recording is active.');
            return;
        }
        this._stop();
        this._owner = owner;
        this._watch = Gio.bus_watch_name_on_connection(Gio.DBus.session, owner,
            Gio.BusNameWatcherFlags.NONE, null, () => this._stop());
        this._buttons = new Buttons(global.get_pointer()[2] & 0x700);
        this._indicator = new PanelMenu.Button(0.0, 'StepForge recording');
        this._indicator.add_child(new St.Label({text: '● StepForge REC', y_align: Clutter.ActorAlign.CENTER}));
        this._indicator.menu.addAction('Stop recording', () => this._stop('Recording stopped from the GNOME panel.'));
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 4, () => {
            try {
                const [x, y, mods] = global.get_pointer();
                const pressed = this._buttons.update(mods & 0x700);
                // Never record unlock dialogs or our own recording controls.
                // Ordinary Shell panel/overview clicks are still useful steps.
                // No key state leaves the Shell.
                if (Main.sessionMode.isLocked || Main.sessionMode.isGreeter) {
                    this._stop('Recording stopped because the session locked.');
                    return GLib.SOURCE_REMOVE;
                }
                if (!pressed.length || this._indicator.menu.isOpen)
                    return GLib.SOURCE_CONTINUE;
                const actor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
                if (actor && this._indicator.contains(actor))
                    return GLib.SOURCE_CONTINUE;
                const context = JSON.parse(this.GetInfo());
                // GLib monotonic time is also used by the PipeWire helper.
                // Sample time is explicit: this is NOT a hardware timestamp.
                const at = GLib.get_monotonic_time() / 1000;
                for (const button of pressed)
                    this._signal('Click', {...context, x, y, at, button});
            } catch (error) {
                console.error(`StepForge capture: ${error.message}`);
                this._stop('GNOME input capture failed. Restart recording.');
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
        invocation.return_value(new GLib.Variant('(s)', [this.GetInfo()]));
    }

    StopAsync(_args, invocation) {
        if (this._owner && invocation.get_sender() !== this._owner) {
            invocation.return_dbus_error(`${IFACE}.NotOwner`, 'This connection does not own the recording.');
            return;
        }
        this._stop();
        invocation.return_value(null);
    }

    _signal(name, value) {
        if (this._owner)
            Gio.DBus.session.emit_signal(this._owner, PATH, IFACE, name,
                new GLib.Variant('(s)', [JSON.stringify(value)]));
    }

    _stop(reason = null) {
        if (reason)
            this._signal('Stopped', {reason});
        this._owner = null;
        if (this._timer) GLib.source_remove(this._timer);
        if (this._watch) Gio.bus_unwatch_name(this._watch);
        this._timer = this._watch = 0;
        this._indicator?.destroy();
        this._indicator = null;
        this._buttons = null;
    }

    disable() {
        this._stop('The required StepForge extension was disabled or the session locked.');
        this._object?.unexport();
        this._object = null;
        if (this._monitorsSignal) Main.layoutManager.disconnect(this._monitorsSignal);
        this._monitorsSignal = 0;
    }
}
