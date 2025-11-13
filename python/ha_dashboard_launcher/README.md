# Home Assistant Dashboard Launcher

## What does it do?

If you use Home Assistant (a smart home system), this script opens your dashboard in a clean window without all the browser buttons and tabs. It's like having a dedicated app just for your smart home controls.

The window:
- Shows your Home Assistant dashboard without browser clutter
- Automatically refreshes every 5 minutes to keep your data current
- Can be dragged around by clicking the top edge
- Opens on your third monitor if you have one (great for dedicated displays)

This is perfect if you want a dedicated screen showing your smart home dashboard all the time.

## How to set up

### Step 1: Make sure Home Assistant is running

You need to have Home Assistant already set up and running. If you don't have it yet, this script won't do much - it's specifically for displaying an existing Home Assistant dashboard.

### Step 2: Install Python

If you don't have Python installed:
1. Go to https://www.python.org/downloads/
2. Download Python 3.9 or newer
3. Run the installer and check "Add Python to PATH"

### Step 3: Install required packages

Open Command Prompt and type:

```
pip install pywebview screeninfo
```

These packages help create the window and handle multiple monitors.

### Step 4: Update the script with your dashboard URL

1. Open `ha_dashboard_launcher.py` in a text editor (like Notepad)
2. Find the line that says `URL = 'http://homeassistant.local:8123/dashboard-home/home'`
3. Replace that web address with your own Home Assistant dashboard URL
4. Save the file

To find your URL:
- Open Home Assistant in your regular browser
- Go to the dashboard you want to display
- Copy the address from the browser's address bar
- Paste it in the script

## How to use it

### Running the dashboard:

1. Double-click `ha_dashboard_launcher.py`
2. The dashboard window will appear

If you have three or more monitors, it will appear on your third monitor. Otherwise, it appears on your main monitor.

### Moving the window:

Click and drag the very top edge of the window (the first 30 pixels or so) to move it around.

### Closing the window:

Press **Alt+F4** or use the Windows task bar to close it.

## Things to know

- **Auto-refresh:** The page reloads every 5 minutes to keep your data fresh
- **No browser controls:** There's no back button or address bar - it's just your dashboard
- **Always running:** The script keeps running until you close the window
- **Customizable:** If 5 minutes is too fast/slow, you can open the script and change the number 300 to a different amount of seconds

## Troubleshooting

**Can't connect to Home Assistant?**
- Make sure Home Assistant is running
- Check that the URL in the script matches your Home Assistant address
- Try opening the URL in a regular browser first to make sure it works

**Wrong monitor?**
- The script tries to use your third monitor
- If you want a different monitor, you'll need to edit the script (change the number 2 to 0 for first monitor, 1 for second, etc.)
