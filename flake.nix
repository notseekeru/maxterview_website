{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
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
              [
                infisical # infisical for cloud secrets source of truth; floats on its own input
              ]
              ++ (with pkgs; [
                curl # the paymongo-operator scripts shell out to curl
                playwright # playwright-core for the @clerk/testing headless sign-in (paymongo-operator)
                chromium # GC-safe headless chrome reference; playwright-core drives it via executablePath
                playwright-mcp # stdio MCP browser server (wrapped: PLAYWRIGHT_BROWSERS_PATH + isolated). Consumed via .pi/mcp.json.
              ]);
          };
        }
      );
    };
}
