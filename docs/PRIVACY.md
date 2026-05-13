# Opzero Chrome Privacy Policy

Effective date: May 13, 2026

Opzero Chrome is a local browser automation extension. It connects Chrome to a native messaging host on the user's machine so an installed Opzero agent skill can control tabs, inspect pages, and run Chrome Debugger Protocol commands at the user's request.

## Data Handled

The extension may handle the following data during an active local agent session:

- Open tab metadata, including tab IDs, window IDs, URLs, titles, and group state.
- Page interaction data returned by Chrome Debugger Protocol commands requested by the local agent.
- Download metadata, including download IDs, filenames, URLs, state, danger status, and error status.
- Browser history search results when the local agent explicitly requests history.
- Extension connection state, extension instance ID, native host status, session state, and pending update markers.

## How Data Is Used

Data is used only to provide local, user-requested browser automation and extension connection status. Opzero Chrome does not sell user data, use user data for advertising, build advertising profiles, or transfer browsing data to an Opzero-operated remote service.

The extension communicates with the native messaging host configured for the installed extension ID. What the local agent does with browser data is controlled by the user's local agent environment and the commands the user gives it.

Opzero Chrome's use and transfer of information received from Chrome APIs follows the Chrome Web Store User Data Policy, including Limited Use requirements.

## Storage

Opzero Chrome stores minimal operational state in Chrome extension storage, including connection status, session/tab state, an extension instance ID, and pending update markers. The native host installer writes a native messaging manifest on disk so Chrome can launch the local host.

Users can remove the extension from `chrome://extensions`, remove the native messaging host manifest, and clear extension storage to delete local extension state.

## Permissions

Opzero Chrome requests only the browser permissions needed for its local automation bridge: native messaging, debugger access, tab control, script injection for the cursor overlay, download status, history lookup on request, tab groups, extension storage, alarms, and host access for pages the user asks the agent to automate.

## Security

The native messaging host is restricted to the configured Chrome extension origin. The extension does not include remote code execution, external script loading, analytics, ads, or tracking pixels.

## Contact

Questions or requests can be opened at https://github.com/opzero1/op-chrome/issues.
