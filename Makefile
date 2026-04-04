.PHONY: build dev run fix check install uninstall clean deps

BIN := zoo
ENTRY := src/main.ts
INSTALL_DIR := $(HOME)/.local/bin

deps:
	bun install

build: deps
	bun build $(ENTRY) --compile --outfile $(BIN)

dev:
	bun run $(ENTRY)

run: build
	./$(BIN)

fix:
	bunx prettier --write src/
	bunx eslint --fix src/

check:
	bunx prettier --check src/
	bunx eslint src/
	bunx tsc --noEmit

install: build
	mkdir -p $(INSTALL_DIR)
	cp $(BIN) $(INSTALL_DIR)/$(BIN)

uninstall:
	rm -f $(INSTALL_DIR)/$(BIN)

clean:
	rm -f $(BIN)
