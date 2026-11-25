# Changelog

## 0.1.1

- Fix touches landing too high on display-zoom devices (iPhone 12/13 mini, 6–8 Plus). These render at a larger UIKit point size than the companion reports, so touches drifted toward the bottom; the viewer now maps to the real UIKit size and they land where you click.
- Swipe up from the bottom edge to go Home, and swipe up then hold to open the App Switcher. The home-indicator gesture can't be injected directly, so these map to the Home button (double-press for the switcher).

## 0.1.0

First release: the booted iOS simulator in a VS Code view, with hardware-decoded H.264 video, live touch, trackpad scrolling, a hardware keyboard, clipboard sync, Home and Lock, and a simulator picker that boots shut-down devices.
