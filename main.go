package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

//go:embed index.html css js
var staticFiles embed.FS

var appSecret = sha256.Sum256([]byte("SGA-GOOGLE-KEY-ENCRYPT-2026"))

func encryptAPIKey(apiKey string) ([]byte, error) {
	block, _ := aes.NewCipher(appSecret[:])
	gcm, _ := cipher.NewGCM(block)
	nonce := make([]byte, gcm.NonceSize())
	io.ReadFull(rand.Reader, nonce)
	return gcm.Seal(nonce, nonce, []byte(apiKey), nil), nil
}

func decryptAPIKey(data []byte) (string, error) {
	block, _ := aes.NewCipher(appSecret[:])
	gcm, _ := cipher.NewGCM(block)
	nonceSize := gcm.NonceSize()
	if len(data) < nonceSize {
		return "", fmt.Errorf("data too short")
	}
	plain, err := gcm.Open(nil, data[:nonceSize], data[nonceSize:], nil)
	return string(plain), err
}

func keyFilePath() string {
	exe, err := os.Executable()
	if err != nil {
		return "googlekey.enc"
	}
	return filepath.Join(filepath.Dir(exe), "googlekey.enc")
}

func loadAPIKey() string {
	data, err := os.ReadFile(keyFilePath())
	if err != nil {
		return ""
	}
	key, _ := decryptAPIKey(data)
	return key
}

func handleKeyStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"hasKey": loadAPIKey() != ""})
}

func handleKey(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	switch r.Method {
	case http.MethodPost:
		var body struct {
			Key string `json:"key"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.Key) == "" {
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprint(w, `{"ok":false}`)
			return
		}
		enc, err := encryptAPIKey(strings.TrimSpace(body.Key))
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			fmt.Fprint(w, `{"ok":false}`)
			return
		}
		os.WriteFile(keyFilePath(), enc, 0600)
		fmt.Fprint(w, `{"ok":true}`)
	case http.MethodDelete:
		os.Remove(keyFilePath())
		fmt.Fprint(w, `{"ok":true}`)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

var httpClient = &http.Client{Timeout: 15 * time.Second}

func handlePlaces(w http.ResponseWriter, r *http.Request) {
	apiKey := loadAPIKey()
	w.Header().Set("Content-Type", "application/json")
	if apiKey == "" {
		w.WriteHeader(http.StatusServiceUnavailable)
		fmt.Fprint(w, `{"status":"NO_KEY","results":[]}`)
		return
	}
	q := r.URL.Query()
	params := url.Values{
		"query":    {q.Get("query")},
		"location": {q.Get("location")},
		"radius":   {q.Get("radius")},
		"language": {"pl"},
		"key":      {apiKey},
	}
	resp, err := httpClient.Get("https://maps.googleapis.com/maps/api/place/textsearch/json?" + params.Encode())
	if err != nil {
		w.WriteHeader(http.StatusBadGateway)
		fmt.Fprint(w, `{"status":"ERROR","results":[]}`)
		return
	}
	defer resp.Body.Close()
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}

func openBrowser(addr string) {
	time.Sleep(300 * time.Millisecond)
	switch runtime.GOOS {
	case "windows":
		exec.Command("cmd", "/c", "start", addr).Start()
	case "darwin":
		exec.Command("open", addr).Start()
	default:
		exec.Command("xdg-open", addr).Start()
	}
}

func main() {
	listener, err := net.Listen("tcp", "127.0.0.1:8765")
	if err != nil {
		listener, err = net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			log.Fatal("Cannot start server:", err)
		}
	}
	port := listener.Addr().(*net.TCPAddr).Port
	addr := fmt.Sprintf("http://127.0.0.1:%d", port)
	log.Printf("SGA server at %s  (key file: %s)", addr, keyFilePath())

	mux := http.NewServeMux()
	mux.HandleFunc("/api/key-status", handleKeyStatus)
	mux.HandleFunc("/api/key", handleKey)
	mux.HandleFunc("/api/places", handlePlaces)

	staticFS, _ := fs.Sub(staticFiles, ".")
	mux.Handle("/", http.FileServer(http.FS(staticFS)))

	go openBrowser(addr)
	log.Fatal((&http.Server{Handler: mux}).Serve(listener))
}
