> To AI reading this, do not implement. This is just notes of users strictly ignore this unless prompted to.

# FEATURES

- have resume feature with import resume with pdf with deps for maintanibility no hand rolling a pdf parser
- and then after the resume feature we can add direct integration to interviews to just pull the resume in the imported by the user (have a toggle to have resume included in the new interview)
- add analytics page for view indepth extensive analytics information, dialing history, a bunch of charts and data
- dialing template + saving template

# FIX

- i think having pointed byok to 100.64.2.2 points to my open llama cpp endpoint cuz the infra lives at my pi(my k3s server) then meaning other people can use my llama cpp on my pc(199.64.2.2) i think. this isnt a problem at first glance since the product is supposed to give free model to use to interview but BYOK is capless, which can abuse the free tier cap to 10
- grill the plan and architecture and code

# REFACTOR

- refactor: brain doc doesnt ask me what i learn, what are my favorite struggles, what i was excited for, what my brain got thinking, etc. and also the crud.md is lowkey redundant. and also it is heavy on specific code that i dont care about, mostly i only care about infra and wiring knowledge and struggles and i actually found interesting.

# INFRA

- paymongo wire up the api keys and fix the skill for it and use the mcp server for internal agent access and also remove stripe from mention accross repo and also remove the secrets of stripe in infisical
- the infisical prod vars are not set becuz of paymongo
- wire up the dev/staging/prod env, i think staging is the main one to focus
- neon branching for per-PR test databases instead of a shared CI postgres service

# PERSONAL ACCOMPLISHMENTS/STRUGGLES THAT GOT ME EXCITED AND THINKING

- because of my existing infra (k3s, terraform, gitops, auto commit pipeline and stuff) is the reason why i can ship fast and automate deployments in my work, reducing friction and im happy i did what i did before and so proud of my architecture
- mcp wiring to playwright, rassled with it non stop, made tradeoffs and decisions and research until agent can independantly see the dom
- clerk, stripe and paymongo and alot of wiring on the 3rd party side but worth it so it can be automated and review by AI and setup by AI removing friction from using browser just for configuration
- dev, stage, prod separation haves another mental model that im very excited to show off, staging is the one that needs to be injected into my brain so i can practice how production deployment works
- currently setting staging rn, i was suprised i needed a separate and extra environment for it. i made another separate module for it in isolation. i shouldve seen this coming this like staging should be isolated not shared, which makes sense but i seemed like i forgot for a moment lol.
