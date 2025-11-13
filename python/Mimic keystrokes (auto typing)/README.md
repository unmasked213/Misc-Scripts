# Realistic Typing Simulator

## What does it do?

This script types out text for you automatically, but in a way that looks like a real person typing. Instead of appearing instantly (which would look robotic), it types one letter at a time with small random pauses between keystrokes - just like you would type naturally.

This is useful when you need to:
- Type out long pieces of text
- Test how a typing animation looks
- Demonstrate something without having to type it yourself live

## How to set up

### Step 1: Install Python

If you don't have Python installed:
1. Go to https://www.python.org/downloads/
2. Download Python 3.9 or newer
3. Run the installer and check "Add Python to PATH"

### Step 2: Install required packages

Open Command Prompt and type:

```
pip install keyboard pyautogui pywin32
```

These are helper tools that let the script simulate typing.

## How to use it

### Step 1: Prepare your text

1. Open the `content_to_imitate.txt` file (it's in the same folder as the script)
2. Delete what's in there
3. Type or paste the text you want the script to type
4. Save and close the file

### Step 2: Run the script

1. Double-click `mimic_keystrokes.py`
2. A window will appear with instructions
3. Click in the place where you want the text to appear (like a text editor, form, or document)
4. The script will count down from 5
5. Watch as it types your text automatically!

### Stopping the script:

- Press the **ESC** key at any time to stop typing

## Things to know

- **Give yourself time:** You have 5 seconds after starting to click where you want to type
- **The typing speed varies:** Random pauses make it look more natural
- **Emergency stop:** Moving your mouse to the corner of the screen will also stop the script (safety feature)
- **Stay focused:** The script types wherever your cursor is, so don't click away while it's typing
- **Any text works:** Copy from Word, from websites, from anywhere - just paste it in the text file

## Example uses

- **Filling out forms:** Need to fill the same form multiple times? Save the text and let the script type it
- **Demonstrations:** Show someone a process without having to type live
- **Testing:** See how your application handles rapid text input
- **Learning:** Watch the text appear as if someone is typing it in real-time
