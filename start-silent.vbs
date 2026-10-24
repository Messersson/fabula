Option Explicit

Const PORT = 17381
Const URL = "http://127.0.0.1:17381/"

Dim fso, ws, root, i
Set fso = CreateObject("Scripting.FileSystemObject")
Set ws = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(WScript.ScriptFullName)
ws.CurrentDirectory = root

' Reuse an existing healthy server and open it.
If IsHealthy(ws, URL) Then
  OpenUrl ws, URL
  WScript.Quit 0
End If

If ws.Run("where.exe node.exe", 0, True) <> 0 Then
  MsgBox "Node.js 22 or newer was not found in PATH." & vbCrLf & _
         "Install Node.js, then run start-silent.vbs again.", 48, "Fabula"
  WScript.Quit 1
End If

On Error Resume Next
ws.Run "node.exe server.js " & PORT, 0, False
If Err.Number <> 0 Then
  MsgBox "Fabula could not be started: " & Err.Description & vbCrLf & _
         "Run start.bat to see the full error.", 48, "Fabula"
  WScript.Quit 1
End If
On Error GoTo 0

For i = 1 To 20
  WScript.Sleep 1000
  If IsHealthy(ws, URL) Then
    OpenUrl ws, URL
    WScript.Quit 0
  End If
Next

MsgBox "Fabula did not become ready." & vbCrLf & _
       "Run start.bat to see the full startup error.", 48, "Fabula"
WScript.Quit 1

Function IsHealthy(shell, target)
  Dim command
  command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command " & _
            Chr(34) & "$ProgressPreference='SilentlyContinue'; try { " & _
            "$r=Invoke-WebRequest -UseBasicParsing -Uri '" & target & _
            "' -TimeoutSec 2; if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500) { exit 0 } " & _
            "} catch {}; exit 1" & Chr(34)
  IsHealthy = (shell.Run(command, 0, True) = 0)
End Function

Sub OpenUrl(shell, target)
  shell.Run "cmd.exe /c start " & Chr(34) & Chr(34) & " " & Chr(34) & target & Chr(34), 0, False
End Sub
