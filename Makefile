.PHONY: build dev run fix check test install uninstall clean

ENTRY := build/dev/javascript/zoo/zoo.mjs
BIN := zoo
INSTALL_DIR := $(HOME)/.local/bin

build: fix
	gleam build --target javascript
	bun build $(ENTRY) --compile --outfile $(BIN)

dev:
	gleam build --target javascript

run: dev
	bun $(ENTRY)

fix:
	gleam format

check:
	gleam format --check
	gleam check --target javascript
	gleam test --target javascript

test:
	gleam test --target javascript

install: build
	mkdir -p $(INSTALL_DIR)
	cp $(BIN) $(INSTALL_DIR)/$(BIN)

uninstall:
	rm -f $(INSTALL_DIR)/$(BIN)

clean:
	rm -rf build $(BIN)
