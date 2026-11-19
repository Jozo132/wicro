#include <stdint.h>

#include <avr/io.h>

#define LED_PIN PB5

static void delay(volatile uint32_t count)
{
    while (count--) {
        asm volatile("nop");
    }
}

int main(void)
{
    DDRB |= (1U << LED_PIN);

    for (;;) {
        PORTB ^= (1U << LED_PIN);
        delay(150000U);
    }
}
