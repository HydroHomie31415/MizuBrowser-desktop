# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

### Mizu mouse gestures settings. Mizu owns these strings rather than adding
### them to Firefox's own preferences.ftl, which upstream localises and
### rewrites; keeping them apart means a Firefox update cannot collide with
### them and they can be translated on Mizu's own schedule.

mizu-gestures-nav = Mouse gestures

mizu-gestures-pane-title =
    .heading = Mouse gestures

mizu-gestures-group =
    .label = Mouse gestures
    .description = Hold the right mouse button over a page and draw to run a command. The stroke is drawn back over the page, and the context menu is skipped when a gesture is recognised.

mizu-gestures-enabled =
    .label = Enable mouse gestures

mizu-gestures-rocker =
    .label = Rocker gestures
    .description = Hold one mouse button and click the other to go back or forward.

mizu-gestures-wheel =
    .label = Wheel gestures
    .description = Hold the right mouse button and turn the wheel to move through tabs.

mizu-gestures-trail =
    .label = Draw the stroke over the page

mizu-gestures-status =
    .label = Show the action a stroke will run

mizu-gestures-threshold =
    .label = How far to move before a direction counts

mizu-gestures-threshold-short =
    .label = Short — quick, less steady
mizu-gestures-threshold-medium =
    .label = Medium
mizu-gestures-threshold-long =
    .label = Long — deliberate, more accurate

mizu-gestures-bindings-group =
    .label = Gestures
    .description = Choose what each stroke does. Record a gesture to add one, or set an action to a dash to remove it.

mizu-gestures-record =
    .label = Record a gesture

mizu-gestures-cancel =
    .label = Cancel

mizu-gestures-remove =
    .title = Remove this gesture

## These are written into an element's text rather than onto one of its
## attributes, so they are plain values with no attribute of their own.

mizu-gestures-recording = Draw the gesture anywhere in this window, holding the right mouse button.

mizu-gestures-rocker-back = Rocker back
mizu-gestures-rocker-forward = Rocker forward
mizu-gestures-wheel-up = Wheel up
mizu-gestures-wheel-down = Wheel down
