import React, { useState, useEffect } from 'react';
import { useStripe, useElements, PaymentElement } from '@stripe/react-stripe-js';
import { loadStripe } from "@stripe/stripe-js";
import { Elements } from "@stripe/react-stripe-js";
import axios from 'axios';
import useGraffiticodeAuth from '@graffiticode/auth-react';

const SetupForm = () => {
  const stripe = useStripe();
  const elements = useElements();

  const [errorMessage, setErrorMessage] = useState(null);

  const handleSubmit = async (event) => {
    // We don't want to let default form submission happen here,
    // which would refresh the page.
    event.preventDefault();

    if (!stripe || !elements) {
      // Stripe.js has not yet loaded.
      // Make sure to disable form submission until Stripe.js has loaded.
      return;
    }

    const { error } = await stripe.confirmSetup({
      //`Elements` instance that was used to create the Payment Element
      elements,
      confirmParams: {
        return_url: 'https://console.graffiticode.org',
      },
    });

    if (error) {
      // This point will only be reached if there is an immediate error when
      // confirming the payment. Show error to your customer (for example, payment
      // details incomplete)
      setErrorMessage(error.message);
    } else {
      // Your customer will be redirected to your `return_url`. For some payment
      // methods like iDEAL, your customer will be redirected to an intermediate
      // site first to authorize the payment, then redirected to the `return_url`.
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <PaymentElement />
      <button disabled={!stripe}>Submit</button>
      {/* Show error message to your customers */}
      {errorMessage && <div>{errorMessage}</div>}
    </form>
  )
};

const stripePromise = loadStripe('pk_test_51LhI57LUz4JwpsJ6p6lzznvkbFNQj8k9LnAYckCJZ4Tv9AZzYHxKafXTKsTS12F8vUpKyELdBvXtvgSmNOzdqug200VALmBhSl');

function SetupApp() {
  const { user } = useGraffiticodeAuth();
  const [clientSecret, setClientSecret] = useState();
  useEffect(() => {
    const fetchSecret = async () => {
      // Both routes act on the signed-in caller only, named by the token.
      const headers = { Authorization: await user.getToken() };
      await axios.post('/api/user', {}, { headers });
      const secretRes = await axios.get('/api/secret', { headers });
      const { client_secret: clientSecret } = secretRes.data;
      setClientSecret(clientSecret);
    };
    // Turn off for now.
    // fetchSecret();
  }, []);

  return (
    clientSecret &&
    <Elements stripe={stripePromise} options={clientSecret}>
      <SetupForm />
    </Elements>
    || <div />
  );
};

export default SetupApp;
