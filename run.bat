@echo off
cd /d %~dp0

title Traffic Vehicle Counting System
color 0A

echo =====================================================
echo        TRAFFIC VEHICLE COUNTING SYSTEM
echo =====================================================
echo.

REM ==============================
REM 1. CHECK PYTHON
REM ==============================
echo [1/7] Checking Python installation...

python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Python is not installed or not added to PATH.
    pause
    exit /b
)

echo Python OK
echo.

REM ==============================
REM 2. CREATE VENV
REM ==============================
echo [2/7] Setting up virtual environment...

if not exist venv (
    python -m venv venv
    echo venv created
) else (
    echo venv already exists
)

echo.

REM ==============================
REM 3. ACTIVATE VENV
REM ==============================
echo [3/7] Activating environment...
call venv\Scripts\activate.bat

echo Activated
echo.

REM ==============================
REM 4. UPGRADE PIP
REM ==============================
echo [4/7] Upgrading pip...
python -m pip install --upgrade pip

echo.

REM ==============================
REM 5. INSTALL DEPENDENCIES
REM ==============================
echo [5/7] Installing requirements...

pip install -r requirements.txt

echo.

REM ==============================
REM 6. CREATE FOLDERS
REM ==============================
echo [6/7] Creating project folders...

if not exist data mkdir data
if not exist data\uploads mkdir data\uploads
if not exist data\outputs mkdir data\outputs
if not exist models mkdir models
if not exist results mkdir results

echo Folders ready
echo.

REM ==============================
REM 7. START BACKEND
REM ==============================
echo [7/7] Starting backend server...
start "Backend API" cmd /c "cd /d %~dp0 && call venv\Scripts\activate.bat && set PYTHONPATH=%cd% && uvicorn src.main:app --host 127.0.0.1 --port 8000 --reload"
echo Waiting Backend...

REM ==============================
REM WAIT SERVER READY (NO CURL)
REM ==============================
:check
powershell -Command ^
"$client = New-Object Net.Sockets.TcpClient; ^
try { ^
    $client.Connect('127.0.0.1',8000); ^
    $client.Close(); ^
    exit 0 ^
} catch { ^
    exit 1 ^
}"

if %errorlevel% neq 0 (
    timeout /t 1 >nul
    goto check
)

REM ==============================
REM OPEN FRONTEND
REM ==============================
echo Opening browser...

start http://127.0.0.1:8000

echo.
echo =====================================================
echo SYSTEM STARTED SUCCESSFULLY
echo Front-End : http://127.0.0.1:8000
echo =====================================================
echo.

pause