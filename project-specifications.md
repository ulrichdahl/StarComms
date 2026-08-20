I think we have all the basics on how to build it!
This is the full requirements to the Star Bridge bot:
- Since we need to add several bots to be able to connect to multiple channels at the same time, we need a way to manage this. I want the bot to be connected to my private server, and then I have /fc-admin to control other servers access to the bot and get some stats about usage. This is also where I can get the link to add the bot to a server after pre-approving it.
- It must store needed information in a local database, sqlite to begin with and then we can expand if needed.
  The data must be mounted on the host server of the docker for persistence.
- Create a docker-compose.yml to run it locally for testing and to setup production deployment.
- Functionality when in use:
  - 2 modes: 
  	command & squads = A command channel (first command channel on server is alpha, nest bravo and so on) and x squad channels (nato designation),
  	joint operations = x nato designated ops channels (all are command channels)
  - Command/ops channels listen for keywords: alert, broadcast, hail and command.
    Hail and Command are followed by nato designation for squad to send message to. 
    Alert and broadcast has no nato designation, since it is to be sent to all bot channels.
    A hail is to another command/ops channel designate by its nato callsign.
  - Messages are simply copied and played back in the channel it was meant for.
  - Per server setting that mutes all others in a channel, when it is relaying a message.
- You control fleet command with a / command: /fc
  - Subfunctions:
    - create : Will start a guide where the user selects what configuration it should set up, with button clicks (if there is no more allowed slots then say so)
      Q1: Select structure type: command & squads or joint operations
      Q2: How many channels: 1-x (limit by bots allowed for the discord server)
	  Then the bot creates the channels and assigns the command or first ops channel to the creating users 
