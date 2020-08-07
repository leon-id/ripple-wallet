'use strict';
const chalk = require('chalk');
const minimist = require('minimist');
const inquirer = require('inquirer');
const _get = require('lodash.get');
const RippleAPI = require('ripple-lib').RippleAPI;
const RippleKeypairs = require('ripple-keypairs');
const RippleAddressCodec = require('ripple-address-codec');
const config = require('./config.json');

const argv = minimist(process.argv.slice(2));
const unattended_mode = argv.mode == 'unattended' || argv.mode == 'quiet';
const quiet_mode = argv.mode == 'quiet';

const currency = argv.currency || config.currency;
const maxFee = argv['max-fee'] || config.maxFee;

if (!unattended_mode){
    console.log(chalk.green('-----------------------------------------------'));
    console.log(chalk.green('Ripple Wallet'), chalk.yellow('Make Payment'));
    console.log(chalk.green('-----------------------------------------------'), "\n");
}

const api = new RippleAPI({
  server: process.env.RIPPLE_API || argv.api || 'wss://s1.ripple.com:443'
});

const waitForBalancesUpdate = (sourceAddress, destinationAddress, origSourceBalance) => {
  Promise.all([
    api.getBalances(sourceAddress, { currency: config.currency }),
    api.getBalances(destinationAddress, { currency: config.currency })
      .catch(handleActNotFound)
  ]).then((newBalances) => {

    if (_get(newBalances, '[0][0].value', 0) < origSourceBalance) {
        if (!quiet_mode) {
          console.log('New source balance:', chalk.green(_get(newBalances, '[0][0].value', 0), config.currency));
          console.log('New destination balance:', chalk.green(_get(newBalances, '[1][0].value', 0), config.currency));
        }
      process.exit(0);
    } else {
      setTimeout(() => waitForBalancesUpdate(sourceAddress, destinationAddress, origSourceBalance), 1000);
    }
  });
};

const handleActNotFound = (err) => {
  if (err.toString().indexOf('actNotFound') !== -1) {
    return [{ currency: config.currency, value: '0' }];
  }
  return Promise.reject(err);
};

const fail = (message) => {
  console.error(chalk.red(message), "\n");
  process.exit(1);
};


const questions = [
  {
    type: 'input',
    name: 'amount',
    default: argv.amount,
    message: 'Enter ' + currency + ' amount to send:',
    validate: (value) => isNaN(parseInt(value)) ? 'Please enter a number' : true,
    when (answers) {
      if (argv.amount) {
        if (!quiet_mode){
            console.log('Using "amount" option from arguments');
        }
        answers.amount = argv.amount;
        } else {
          return true;
      }
    }
  },
  {
    type: 'input',
    name: 'destinationAddress',
    default: argv.to,
    message: 'Enter destination address:',
    validate: (value) => RippleAddressCodec.isValidAddress(value) ? true : 'Please enter a valid address',
    when (answers) {
      if (argv.to) {
        if (!quiet_mode){
            console.log('Using "destinationAddress" option from arguments');
        }
        answers.destinationAddress = argv.to;
        } else {
          return true;
      }
    }
  },
  {
    type: 'input',
    name: 'destinationTag',
    default: argv.tag,
    message: 'Enter destination tag (optional):',
    validate: (value) => value && isNaN(parseInt(value)) ? 'Please enter a number' : true,
    filter: (value) => value && parseInt(value) || '',
    when (answers) {
      if (argv.tag) {
        if (!quiet_mode){
            console.log('Using "destinationTag" option from arguments');
        }
        answers.destinationTag = argv.tag;
        } else {
          return true;
      }
    }
  },
  {
    type: 'input',
    name: 'sourceSecret',
    message: 'Enter sender secret:',
    validate: (value) => {
      try {
        RippleKeypairs.deriveKeypair(value);
        return true;
      } catch (e) {
        return 'Invalid secret';
      }
    },
    when (answers) {
      if (argv.secret) {
        if (!quiet_mode){
            console.log('Using "sourceSecret" option from arguments :' + argv.secret);
        }
        answers.sourceSecret = argv.secret;
        } else {
          return true;
      }
    }
  }
];

async function pay_xrp(){

try{

let answers = {
  amount: argv.amount,
  destinationAddress:argv.to,
  destinationTag: argv.tag,
  sourceSecret: argv.secret
};

if (!unattended_mode){
    answers = await inquirer.prompt(questions);
}

if (!quiet_mode){
    console.log('answers.destinationAddress = ' + answers.destinationAddress);
    console.log('answers.destinationTag = ' + answers.destinationTag);
    console.log('answers.amount = ' + answers.amount);
    console.log('answers.sourceSecret = ' + answers.sourceSecret);
}
  const keypair = RippleKeypairs.deriveKeypair(answers.sourceSecret);
  const sourceAddress = RippleKeypairs.deriveAddress(keypair.publicKey);

  const instructions = {
    maxLedgerVersionOffset: 5,
    maxFee
  };

  const payment = {
    source: {
      address: sourceAddress,
      maxAmount: {
        value: answers.amount.toString(),
        currency
      }
    },
    destination: {
      address: answers.destinationAddress,
      tag: answers.destinationTag || undefined,
      amount: {
        value: answers.amount.toString(),
        currency
      }
    }
  };

  api.connect().then(() => {
    if (sourceAddress === answers.destinationAddress) {
      fail('Sender address not be the same as the destination address');
    }

    return Promise.all([
      api.getBalances(sourceAddress, { currency: config.currency }),
      api.getBalances(answers.destinationAddress, { currency: config.currency })
        .catch(handleActNotFound)
    ]).then((currentBalances) => {
      const destinationBalance = +(_get(currentBalances, '[1][0].value', 0));
      const sourceBalance = +(_get(currentBalances, '[0][0].value', 0));
      const amount = +(answers.amount);

      if (!quiet_mode){ console.log('Current destination balance:', chalk.green(destinationBalance, config.currency));}
      if (destinationBalance + amount < config.baseReserve) {
        fail(`Send at least ${config.baseReserve} ${config.currency} to create the destination address`);

      }
      if (!quiet_mode){ console.log('Current sender balance:', chalk.green(sourceBalance, config.currency)); }
      if (sourceBalance - amount < config.baseReserve) {
        fail(`There should be at least ${config.baseReserve} ${config.currency} remaining at the sender address`);
      }

      inquirer.prompt([
        {
          type: 'confirm',
          name: 'sure',
          default: false,
          message: 'Ready to send?',
          when (confirm) {
             if (unattended_mode) {
               if (!quiet_mode){
                   console.log('unattended mode on, autoconfirming');
               }
               confirm.sure = true;
               } else {
                 return true;
             }
           }
        }
      ]).then((confirm) =>
         {
            if (!confirm.sure && !unattended_mode) {
              console.log('exiting...');
              process.exit();
            }
            if (!quiet_mode){ console.log("\nPreparing payment transaction..."); }
            return api.preparePayment(sourceAddress, payment, instructions).then(prepared =>
                {
                  const { signedTransaction } = api.sign(prepared.txJSON, answers.sourceSecret);
                  if (quiet_mode) { console.log(signedTransaction); }
                  else {  console.log('Submitting payment...'); }
                  return api.submit(signedTransaction).then(() => {
                    if (!quiet_mode){  console.log('Waiting for balance to update (use Ctrl-C to abort)'); }
                    waitForBalancesUpdate(sourceAddress, answers.destinationAddress, sourceBalance);
                  }, fail);
                });
         });
    });

  }).catch(fail);
}
  catch(err) {
    console.log(err);
  }
}

pay_xrp();
