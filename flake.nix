{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    # Decoupled from nixpkgs so `nix flake update nixpkgs-infisical` moves the
    # infisical CLI alone, without dragging nodejs/playwright/chromium with it.
    # Separate ref from the nixpkgs input on purpose: identical refs collapse
    # into one flake.lock node and lose the ability to be updated in isolation.
    nixpkgs-infisical.url = "https://channels.nixos.org/nixos-unstable/nixexprs.tar.xz";
  };

  outputs =
    { self, nixpkgs, nixpkgs-infisical }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          infisical = nixpkgs-infisical.legacyPackages.${system}.infisical;
        in
        {
          default = pkgs.mkShell {
            packages =
              [ infisical # infisical for cloud secrets source of truth; floats on its own input
              ]
              ++ (with pkgs; [
              curl # the paymongo-operator scripts shell out to curl
              nodejs # host runtime for the @clerk/testing + Playwright headless Clerk e2e
              playwright # playwright-core (CJS require-able) for the hermetic-e2e host-direct runner
              chromium # GC-safe headless chrome reference; playwright-core drives it via executablePath
              playwright-mcp # stdio MCP browser server (wrapped: PLAYWRIGHT_BROWSERS_PATH + isolated). Consumed via .mcp.json.
              ]);
          };
        }
      );
    };
}
