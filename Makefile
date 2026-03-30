.PHONY: build dev run fix check install uninstall clean

BIN := zoo
ENTRY := src/main.ts
INSTALL_DIR := $(HOME)/.local/bin

build:
	bun build $(ENTRY) --compile --outfile $(BIN)

dev:
	bun run $(ENTRY)

run: build
	./$(BIN)

fix:
	@echo "No auto-fix needed for TypeScript/Bun"

check:
	bun run $(ENTRY) --help > /dev/null

install: build
	mkdir -p $(INSTALL_DIR)
	cp $(BIN) $(INSTALL_DIR)/$(BIN)

uninstall:
	rm -f $(INSTALL_DIR)/$(BIN)

clean:
	rm -f $(BIN)
