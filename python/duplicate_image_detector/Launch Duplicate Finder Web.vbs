Set WshShell = CreateObject("WScript.Shell")
Set FSO = CreateObject("Scripting.FileSystemObject")

' Set working directory to script location
WshShell.CurrentDirectory = FSO.GetParentFolderName(WScript.ScriptFullName)

' Run server.py with pythonw.exe (windowless Python)
' pythonw.exe runs Python scripts without showing a console window
' The 0 means hidden window (redundant with pythonw but doesn't hurt), False means don't wait for completion
WshShell.Run "pythonw server.py", 0, False
