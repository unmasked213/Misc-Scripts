Set WshShell = CreateObject("WScript.Shell")
Set FSO = CreateObject("Scripting.FileSystemObject")

' Set working directory to script location
WshShell.CurrentDirectory = FSO.GetParentFolderName(WScript.ScriptFullName)

' Run server.py with windowless Python. Quote the script path so folders with
' spaces work correctly. The server binds only to the local computer.
ScriptPath = FSO.BuildPath(WshShell.CurrentDirectory, "server.py")
WshShell.Run "pythonw.exe " & Chr(34) & ScriptPath & Chr(34), 0, False
