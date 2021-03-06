const Discord = require('discord.js');
const DiscordClient = Discord.Client;
const fs = require('fs');
const Log = require('../Util/Log');
const Guild = require('../Models/Guild');

/**
 * @typedef {external:ClientOptions} ClientOptions
 * @property {String} prefix discord bot's prefix
 * @property {String} owner discord bot's owner user id
 * @property {String} [name] discord bot's name
 */

/**
 * Yappy's custom Discord client
 * @extends {external:Client}
 */
class Client extends DiscordClient {
  /**
   * The main hub for interacting with the Discord API, and the starting point for any bot.
   * @param {ClientOptions}
   */
  constructor(opts = {}, ...args) {
    super(opts, ...args);

    /**
     * Discord bot's commands
     * @type {Collection}
     */
    this.commands = new Discord.Collection();

    /**
     * Discord bot's middleware
     * @type {Collection}
     */
    this.middleware = new Discord.Collection();

    /**
     * Discord bot's command aliases
     * @type {Collection}
     */
    this.aliases = new Discord.Collection();

    /**
     * Discord bot's prefix
     * @type {String}
     */
    this.prefix = opts.prefix || '';

    /**
     * Discord bot's name
     * @type {String}
     */
    this.name = opts.name || 'Unknown';

    this.config = {
      owner: opts.owner,
    };
  }

  /**
   * Load commands from directory
   * @param {String} cwd path to commands directory
   */
  loadCommands(cwd) {
    fs.readdir(cwd, (err, files) => {
      if (err) {
        this.emit('error', err);
        return this;
      }

      if (!files.length) {
        Log.info(`Command | No Commands Loaded.`);
        return this;
      }

      files.forEach((f) => {
        try {
          this.addCommand(require(`./Commands/${f}`), f);
        } catch (error) {
          this.emit('error', `Command | ${f}`, error);
        }
      });
      return this;
    });
  }

  /**
   * Register command
   * @param {Command} Cmd
   * @param {String} file
   */
  addCommand(Cmd, file) {
    try {
      const command = new Cmd(this);
      Log.debug(`Command | Loading ${command.help.name}.`);
      if (file) command.props.help.file = file;

      this.commands.set(command.help.name, command);

      command.conf.aliases.forEach((alias) => {
        this.aliases.set(alias, command.help.name);
      });
    } catch (error) {
      this.emit('error', `Command | ${file || Cmd.name}`, error);
    }
  }

  /**
   * Load modules from directory
   * @param {String} cwd path to modules directory
   */
  loadModules(cwd) {
    fs.readdir(cwd, (err, files) => {
      if (err) {
        this.emit('error', err);
        return this;
      }

      if (!files.length) {
        Log.info(`Module | No Modules Loaded.`);
        return this;
      }

      files.forEach((f) => {
        try {
          const module = new (require(`./Modules/${f}`))(this);
          const name = module.constructor.name.replace('Module', '');

          Log.debug(`Module | Loading ${name}. ????`);

          this.middleware.set(name, module);
        } catch (error) {
          this.emit('error', `Module | ${f}`, error);
        }
      });
      return this;
    });
  }

  /**
   * Reload command
   * @param {String} command command to reload
   * @return {Promise}
   */
  reloadCommand(command) {
    return new Promise((resolve, reject) => {
      try {
        delete require.cache[require.resolve(`./Commands/${command}`)];
        Log.debug(`Command | Reloading ${command} ????`);
        let cmd = require(`./Commands/${command}`);
        let Command = new cmd(this);
        Command.props.help.file = command;
        this.commands.set(Command.help.name, Command);
        Command.conf.aliases.forEach((alias) => {
          this.aliases.set(alias, Command.help.name);
        });
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  }

  /**
   * Reload file
   * @param {String} file path of file to reload
   * @return {Promise<any>}
   */
  async reloadFile(file) {
    return new Promise((resolve, reject) => {
      try {
        delete require.cache[require.resolve(file)];
        let thing = require(file);
        resolve(thing);
      } catch (e) {
        reject(e);
      }
    });
  }

  /**
   * Message event handling, uses modules (aka middleware)
   * @param {Message} msg
   * @return {Client}
   */
  async runCommand(msg) {
    if (msg.author.equals(this.user) || msg.author.bot) return;
    const serverConf = msg.guild && (await Guild.find(msg.guild.id));
    const prefix = serverConf && serverConf.get('prefix');

    if (
      !msg.mentions.has(this.user) &&
      !(prefix && prefix.length && msg.content.startsWith(prefix)) &&
      !msg.content.startsWith(this.prefix)
    )
      return;

    const content = this.getMsgContent(msg, prefix);
    const command = content.split(' ')[0].toLowerCase();
    const args = content.split(' ').slice(1);

    const middleware = this.middleware
      .array()
      .sort((a, b) => b.priority - a.priority);
    let i = 0;

    const handleErr = (err, currentMiddleware) =>
      middleware[middleware.length - 1].run(
        msg,
        args,
        next,
        currentMiddleware,
        err
      );

    const next = (err) => {
      const currentMiddleware = middleware[i] || middleware[i - 1];
      const nextMiddleware = middleware[i++];
      if (err) return handleErr(err, currentMiddleware);
      if (nextMiddleware) {
        try {
          const thisMiddleware = nextMiddleware.run(msg, args, next, command);
          if (
            thisMiddleware.catch &&
            typeof thisMiddleware.catch === 'function'
          ) {
            thisMiddleware.catch((e) =>
              handleErr(e, nextMiddleware || currentMiddleware)
            );
          }
        } catch (e) {
          handleErr(err, nextMiddleware || currentMiddleware);
        }
      }
    };

    next();

    return this;
  }

  commandError(msg, cmd, err) {
    this.emit('error', err);
    return msg.channel
      .send([
        `??? An unexpected error occurred when trying to run command \`${cmd.help.name}\``,
        `\`${err}\``,
      ])
      .catch(() => {
        if (err && typeof err === 'object' && err.response)
          err = err.response
            ? err.response.body || err.response.text
            : err.stack;
        if (err && typeof err === 'object' && err.content)
          err = `Discord - ${err.content ? err.content[0] : err.message}`;
        if (err && typeof err === 'object' && err.code && err.message)
          err = err.message;

        msg.author.send([
          `??? An unexpected error occurred when trying to run command \`${cmd.help.name}\` in ${msg.channel}`,
          `\`${err}\``,
        ]);
      });
  }

  /**
   * Remove prefix/mention from message content
   * @param  {Message} message    Message
   * @param  {String} prefix Guild prefix
   * @return {String}        Message content without prefix or mention
   */
  getMsgContent(message, prefix) {
    const { content, mentions } = message;

    return (
      (prefix &&
        prefix.length &&
        content.startsWith(prefix) &&
        content.replace(prefix, '')) ||
      (mentions.users.size &&
        mentions.users.first().equals(this.user) &&
        content.split(' ').slice(1).join(' ')) ||
      (content.startsWith(this.prefix) && content.replace(this.prefix, '')) ||
      content
    );
  }

  permissions(msg) {
    /* This function should resolve to an ELEVATION level which
    is then sent to the command handler for verification*/
    let permlvl = 0;

    if (msg.member && msg.member.hasPermission(`ADMINISTRATOR`)) permlvl = 1;
    if (this.config.owner === msg.author.id) permlvl = 2;

    return permlvl;
  }

  generateArgs(strOrArgs = '') {
    let str = Array.isArray(strOrArgs) ? strOrArgs.join(' ') : strOrArgs;
    let y = str.match(/[^\s'']+|'([^']*)'|'([^']*)'/g);
    if (y === null) return str.split(' ');
    return y.map((e) => e.replace(/'/g, ``));
  }

  embed(title, text, color, fields) {
    let embed = {
      title,
      description: text,
      color: color ? parseInt(`0x${color}`, 16) : `0x${color}`,
      fields: [],
    };
    if (fields && !Array.isArray(fields)) {
      Object.keys(fields).forEach((fieldName) => {
        embed.fields.push({
          name: fieldName,
          value: fields[fieldName],
        });
      });
    } else if (fields && Array.isArray(fields)) {
      embed.fields = fields;
    }
    return embed;
  }
}

module.exports = Client;
