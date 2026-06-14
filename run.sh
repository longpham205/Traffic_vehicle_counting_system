#!/bin/bash

cd "$(dirname "$0")"

echo "====================================================="
echo "       TRAFFIC VEHICLE COUNTING SYSTEM"
echo "====================================================="
echo

# ==============================
# 1. CHECK PYTHON
# ==============================
echo "[1/7] Checking Python installation..."

if ! command -v python3 &> /dev/null; then
    echo "ERROR: Python3 is not installed or not in PATH."
    exit 1
fi

python3 --version
echo "Python OK"
echo

# ==============================
# 2. CREATE VENV
# ==============================
echo "[2/7] Setting up virtual environment..."

if [ ! -d "venv" ]; then
    python3 -m venv venv
    echo "venv created"
else
    echo "venv already exists"
fi

echo

# ==============================
# 3. ACTIVATE VENV
# ==============================
echo "[3/7] Activating environment..."
source venv/bin/activate

echo "Activated"
echo

# ==============================
# 4. UPGRADE PIP
# ==============================
echo "[4/7] Upgrading pip..."
python -m pip install --upgrade pip

echo

# ==============================
# 5. INSTALL DEPENDENCIES
# ==============================
echo "[5/7] Installing requirements..."
pip install -r requirements.txt

echo

# ==============================
# 6. CREATE FOLDERS
# ==============================
echo "[6/7] Creating project folders..."

mkdir -p data/uploads
mkdir -p data/outputs
mkdir -p models
mkdir -p results

echo "Folders ready"
echo

# ==============================
# 7. START BACKEND
# ==============================
echo "[7/7] Starting backend server..."

uvicorn src.main:app --host 127.0.0.1 --port 8000 --reload &
BACKEND_PID=$!

echo "Waiting Backend..."

# ==============================
# WAIT SERVER READY
# ==============================
until python -c "import socket; exit(socket.socket().connect_ex(('127.0.0.1',8000)))"
do
    sleep 1
done
# ==============================
# OPEN FRONTEND
# ==============================
echo "Opening browser..."

URL="http://127.0.0.1:8000"

if command -v python >/dev/null 2>&1; then
    python -c "import webbrowser; webbrowser.open('$URL')"
fi

echo
echo "====================================================="
echo "SYSTEM STARTED SUCCESSFULLY"
echo "Front-end : http://127.0.0.1:8000"
echo "====================================================="
echo

wait $BACKEND_PID