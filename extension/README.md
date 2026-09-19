# RockReader browser extension

Sends the page you are reading, or just the text you selected, to your RockReader server and opens it in the reader. Because it runs inside your browser it works on pages behind a login and pages that only render with JavaScript.

## Install (Chrome, Arc, Brave, Edge)

1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked**, choose this `extension/` folder.
3. Click the extension's **Options** and set the server address, for example `http://rockreader.local:8880`, and a default voice.

## Use

- Click the toolbar icon to read the whole page (article text only, extracted with Mozilla's Readability).
- Select text, right-click, **Read selection with RockReader**.

The extension asks for access to all sites so it can read any page and reach your server on the local network. It sends text only to the server address you configured.
