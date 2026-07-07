@echo off
cd /d C:\apps\OmniRoute
set PATH=C:\Program Files\nodejs;C:\Users\Administrator\AppData\Roaming\npm;%PATH%
npm run start >> C:\apps\logs\omniroute-start.log 2>&1
