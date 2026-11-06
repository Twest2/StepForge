#!/usr/bin/python3
import gi
gi.require_version('Gtk', '4.0')
from gi.repository import Gtk
import json
from pathlib import Path
app = Gtk.Application(application_id='org.stepforge.KdeTarget')
count = 0
def activate(application):
    window = Gtk.ApplicationWindow(application=application, title='StepForge KDE recording target')
    window.set_default_size(800, 550)
    area = Gtk.DrawingArea()
    def draw(_area, cr, w, h):
        cr.set_source_rgb(0.9, 0.95, 1)
        cr.paint()
        cr.set_source_rgb(0.1, 0.65 if count % 2 == 0 else 0.25, 0.3)
        cr.rectangle(40, 100, w - 80, h - 150)
        cr.fill()
        cr.set_source_rgb(0, 0, 0)
        cr.set_font_size(28)
        cr.move_to(40, 60)
        cr.show_text(f'KDE capture target: {count} clicks')
    area.set_draw_func(draw)
    click = Gtk.GestureClick()
    click.set_button(0)
    def clicked(_gesture, n, x, y):
        global count
        count += 1
        Path('/artifacts/target-events.json').write_text(json.dumps({'count': count, 'x': x, 'y': y}))
        area.queue_draw()
    click.connect('pressed', clicked)
    area.add_controller(click)
    window.set_child(area)
    keyboard = Gtk.EventControllerKey()
    def key_pressed(_controller, keyval, keycode, state):
        with Path('/artifacts/target-keys.jsonl').open('a') as log:
            log.write(json.dumps({'keyval': keyval, 'keycode': keycode, 'state': int(state)}) + '\n')
        return False
    keyboard.connect('key-pressed', key_pressed)
    window.add_controller(keyboard)
    window.present()
app.connect('activate', activate)
app.run([])
